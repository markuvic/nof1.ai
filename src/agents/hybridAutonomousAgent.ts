import { Agent, Memory } from "@voltagent/core";
import { LibSQLMemoryAdapter } from "@voltagent/libsql";
import { createPinoLogger } from "@voltagent/logger";
import { createOpenAI } from "@ai-sdk/openai";
import * as tradingTools from "../tools/trading";
import { RISK_PARAMS } from "../config/riskParams";
import { formatChinaTime } from "../utils/timeUtils";
import type { HybridContext, HybridSymbolSnapshot } from "../services/hybridContext";

const logger = createPinoLogger({
  name: "hybrid-autonomous-agent",
  level: (process.env.LOG_LEVEL || "info") as any,
});

const systemMaxLeverage = Math.min(10, RISK_PARAMS.MAX_LEVERAGE);

function generateSystemInstructions(intervalMinutes: number): string {
  return `你是一位拥有丰富交易经验的混合自主架构（Hybrid Autonomous）加密交易员，擅长进行中短期永续合约交易，具备独立学习、策略构建与自我迭代的能力。

你的使命：
- 持续吸收最新的裸K、量价、仓位与账户反馈，自主总结规律；
- 在 ${intervalMinutes} 分钟轮询节奏中快速适应市场结构，形成下一步策略；
- 以长期风险调整后收益为核心（Sharpe Ratio 最大化），将账户回撤控制在 30% 以内，保持胜率 ≥ 60%、盈亏比 ≥ 2:1。

你的权限：
- 你可以通过工具调用执行任何必要操作：openPosition、closePosition、getMarketPrice、getPositions、getAccountBalance、getOrderBook、getTechnicalIndicators、getFundingRate、calculateRisk、syncPositions 等；
- 你可以请求任意市场数据工具来验证假设，或在没有把握时保持观望。
- 永续合约杠杆上限 ${systemMaxLeverage}x

你的交易喜好：
- 你主做短线交易，快进快出，寻找可能的盈利机会
- 你不要对某一个方向有偏好，做多和做空都是盈利的机会，根据自主的分析策略，选择你的交易方向


牢记：没有任何预设策略，所有逻辑需要你基于当前市场状态重新推导与验证。`;
}

// 你的硬性约束：
// - 单笔亏损不得超过 5%（若达阈值必须主动止损）；
// - 总回撤 ≤ 30%，超过即以保账户为先；
// - 杠杆上限 ${systemMaxLeverage}x（若环境值更低，以更低者为准），禁止同一币种对冲；
// - 系统级自动风控（止盈/止损/移动止盈）始终在线，你的计划需要与其协同而非对抗。

export interface HybridPromptInput {
  minutesElapsed: number;
  iteration: number;
  intervalMinutes: number;
  hybridContext: HybridContext;
  accountInfo: any;
  positions: any[];
  tradeHistory?: any[];
  recentDecisions?: any[];
}

function formatNumber(value: number, digits = 2, fallback = "0"): string {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return value.toFixed(digits);
}

function describeDirection(direction: "up" | "down" | "flat"): string {
  if (direction === "up") return "上升";
  if (direction === "down") return "下降";
  return "持平";
}

function describeMomentum(momentum: "expanding" | "contracting" | "neutral"): string {
  if (momentum === "expanding") return "动能增强";
  if (momentum === "contracting") return "动能减弱";
  return "动能平稳";
}

function formatMultiTimeframe(snapshot: HybridSymbolSnapshot): string {
  const header = "Interval | Price | EMA20 | EMA50 | MACD | RSI14 | Volume/Avg";
  const rows = snapshot.multiTimeframe
    .map((tf) => {
      return `${tf.interval} | ${formatNumber(tf.currentPrice, 2)} | ${formatNumber(tf.ema20, 2)} | ${formatNumber(tf.ema50, 2)} | ${formatNumber(tf.macd, 3)} | ${formatNumber(tf.rsi14, 2)} | ${formatNumber(tf.volume, 1)}/${formatNumber(tf.avgVolume, 1)}`;
    })
    .join("\n");
  return `${header}\n${rows}`;
}

function formatNakedKData(symbol: string, hybridContext: HybridContext): string {
  const dataset = hybridContext.nakedKData[symbol];
  if (!dataset) {
    return "暂无裸K数据。\n";
  }
  let out = `裸K缓存配置：${dataset.profileId}\n`;
  for (const [frame, entry] of Object.entries(dataset.frames)) {
    const candles = entry.candles.slice(-15);
    if (!candles.length) {
      continue;
    }
    const csvRows = ["idx,open,high,low,close,vol"];
    candles.forEach((candle, idx) => {
      csvRows.push(
        `${idx},${formatNumber(candle.open, 3)},${formatNumber(candle.high, 3)},${formatNumber(candle.low, 3)},${formatNumber(candle.close, 3)},${formatNumber(candle.volume, 1)}`,
      );
    });
    out += `- ${frame} 最近 ${candles.length} 根:\n`;
    out += "```csv\n";
    out += `${csvRows.join("\n")}\n`;
    out += "```\n";
  }
  return out;
}

function formatSymbolSnapshot(symbol: string, snapshot: HybridSymbolSnapshot, hybridContext: HybridContext): string {
  const lines: string[] = [];
  lines.push(`### ${symbol}`);
  lines.push(`价格 ${formatNumber(snapshot.price, 2)} USDT（24h ${formatNumber(snapshot.change24h, 2)}%）`);
  lines.push(`资金费率 ${formatNumber(snapshot.fundingRate, 6)} (${snapshot.fundingDirection === "positive" ? "多头付费" : snapshot.fundingDirection === "negative" ? "空头付费" : "中性"})`);
  lines.push(`成交量 当前 ${formatNumber(snapshot.volume.current, 1)} vs 平滑 ${formatNumber(snapshot.volume.average, 1)}`);
  lines.push(`ATR14 ${formatNumber(snapshot.atr.value, 3)} (${formatNumber(snapshot.atr.percent, 2)}%) ${describeDirection(snapshot.atr.direction)} Δ${formatNumber(snapshot.atr.delta, 3)}`);
  lines.push(`盘口压差：买盘 ${formatNumber(snapshot.orderBookPressure.bidVolume, 1)} / 卖盘 ${formatNumber(snapshot.orderBookPressure.askVolume, 1)}，差值 ${formatNumber(snapshot.orderBookPressure.delta, 1)}，比例 ${formatNumber(snapshot.orderBookPressure.ratio, 2)}`);
  lines.push(
    `EMA20/50/200 = ${formatNumber(snapshot.ema.ema20.value, 2)} (${describeDirection(snapshot.ema.ema20.direction)}), ${formatNumber(snapshot.ema.ema50.value, 2)} (${describeDirection(snapshot.ema.ema50.direction)}), ${formatNumber(snapshot.ema.ema200.value, 2)} (${describeDirection(snapshot.ema.ema200.direction)}) [排列: ${snapshot.ema.alignment}]`,
  );
  lines.push(
    `MACD ${formatNumber(snapshot.macd.macd, 4)}, Signal ${formatNumber(snapshot.macd.signal, 4)}, Histogram ${formatNumber(snapshot.macd.histogram, 4)}（${describeMomentum(snapshot.macd.momentum)}）`,
  );
  lines.push(
    `RSI7 ${formatNumber(snapshot.rsi.rsi7.value, 2)} (近5周期变化 ${formatNumber(snapshot.rsi.rsi7.changeOver5, 2)}), RSI14 ${formatNumber(snapshot.rsi.rsi14.value, 2)} (近5周期变化 ${formatNumber(snapshot.rsi.rsi14.changeOver5, 2)})`,
  );
  lines.push(
    `布林带：上轨 ${formatNumber(snapshot.bollinger.upper, 2)}, 下轨 ${formatNumber(snapshot.bollinger.lower, 2)}, 带宽 ${formatNumber(snapshot.bollinger.bandwidthPercent, 2)}%`,
  );
  lines.push("\n多时间框架指标：");
  lines.push(formatMultiTimeframe(snapshot));
  lines.push("\n裸K 数据：");
  lines.push(formatNakedKData(symbol, hybridContext));
  return lines.join("\n") + "\n";
}

function formatAccountSection(accountInfo: any): string {
  const lines: string[] = [];
  const total = Number(accountInfo?.totalBalance ?? accountInfo?.total ?? 0);
  const available = Number(accountInfo?.availableBalance ?? accountInfo?.available ?? 0);
  const unrealized = Number(accountInfo?.unrealisedPnl ?? 0);
  const initial = Number(accountInfo?.initialBalance ?? total);
  const peak = Number(accountInfo?.peakBalance ?? total);
  const drawdownFromPeak = peak > 0 ? ((peak - total) / peak) * 100 : 0;
  const drawdownFromInitial = initial > 0 ? ((initial - total) / initial) * 100 : 0;
  lines.push(`当前账户价值：${formatNumber(total, 2)} USDT（可用 ${formatNumber(available, 2)}，未实现盈亏 ${formatNumber(unrealized, 2)}）`);
  lines.push(`初始 ${formatNumber(initial, 2)} USDT / 峰值 ${formatNumber(peak, 2)} USDT`);
  lines.push(`回撤：从峰值 ${formatNumber(drawdownFromPeak, 2)}%，从初始 ${formatNumber(drawdownFromInitial, 2)}%`);
  lines.push(`账户收益率：${formatNumber(Number(accountInfo?.returnPercent ?? 0), 2)}%，Sharpe ${formatNumber(Number(accountInfo?.sharpeRatio ?? 0), 3)}`);
  return lines.join("\n");
}

function formatPositions(positions: any[]): string {
  if (!positions || positions.length === 0) {
    return "当前无持仓。";
  }
  return positions
    .map((pos) => {
      const sideText = pos.side === "long" ? "做多" : "做空";
      const entryPrice = Number.parseFloat(pos.entryPrice || pos.entry_price || "0");
      const currentPrice = Number.parseFloat(pos.markPrice || pos.current_price || "0");
      const unrealized = Number.parseFloat(pos.unrealisedPnl || pos.unrealized_pnl || "0");
      const pnlPercent =
        Number.isFinite(pos.pnl_percent)
          ? Number(pos.pnl_percent)
          : entryPrice > 0 && currentPrice > 0
            ? ((currentPrice - entryPrice) / entryPrice) * 100 * (pos.side === "long" ? 1 : -1) * (pos.leverage || 1)
            : 0;
      return `• ${pos.symbol} ${sideText} ${pos.quantity} 张 @ ${formatNumber(entryPrice, 2)}，现价 ${formatNumber(currentPrice, 2)}，杠杆 ${pos.leverage || "-"}x，未实现盈亏 ${formatNumber(unrealized, 2)} USDT，杠杆盈亏 ${formatNumber(pnlPercent, 2)}%`;
    })
    .join("\n");
}

function formatDecisionMemory(recentDecisions: any[] = []): string {
  if (!recentDecisions.length) {
    return "暂无历史决策记录。";
  }
  const rows = recentDecisions.slice(-3).map((decision: any) => {
    return `#${decision.iteration} ${formatChinaTime(decision.timestamp)} | 净值 ${formatNumber(decision.account_value, 2)} | 持仓 ${decision.positions_count} | 结论：${decision.decision ?? "—"}`;
  });
  return rows.join("\n");
}

function formatFeedback(tradeHistory: any[] = []): string {
  if (!tradeHistory.length) {
    return "暂无交易反馈。";
  }
  const closes = tradeHistory.filter((trade) => trade.type === "close");
  if (!closes.length) {
    return "暂无平仓记录用于反馈。";
  }
  const last = closes[closes.length - 1];
  const sideText = last.side === "long" ? "多单" : "空单";
  const verdict = Number(last.pnl || 0) >= 0 ? "盈利" : "亏损";
  const pnlText = last.pnl !== null && last.pnl !== undefined
    ? `${last.pnl >= 0 ? "+" : ""}${formatNumber(Number(last.pnl), 2)} USDT`
    : "未知盈亏";
  return `上次 ${last.symbol} ${sideText} ${verdict} ${pnlText}，杠杆 ${last.leverage}x，成交价 ${formatNumber(Number(last.price), 2)}，请总结结构判断对错与下一步优化。`;
}

export function generateHybridPrompt(data: HybridPromptInput): string {
  const {
    minutesElapsed,
    iteration,
    intervalMinutes,
    hybridContext,
    accountInfo,
    positions,
    tradeHistory = [],
    recentDecisions = [],
  } = data;

  const currentTime = formatChinaTime();
  let prompt = `【Hybrid 交易周期 #${iteration}】${currentTime}
已运行 ${minutesElapsed} 分钟，循环周期 ${intervalMinutes} 分钟

系统提示：系统级止盈/止损/移动止盈持续运行，你的决策需要考虑其可能触发点。

【账户状态】
${formatAccountSection(accountInfo)}

【持仓概览】
${formatPositions(positions)}
`;

  const symbols = Object.keys(hybridContext.snapshots).sort();
  if (!symbols.length) {
    prompt += "\n⚠️ 未获取到任何交易对的市场数据，请先调用数据工具确认。\n";
  } else {
    prompt += "\n【市场深度与多时间框架数据】\n";
    for (const symbol of symbols) {
      const snapshot = hybridContext.snapshots[symbol];
      prompt += `${formatSymbolSnapshot(symbol, snapshot, hybridContext)}\n`;
    }
  }

  prompt += `【记忆系统 · 历史决策摘要】
${formatDecisionMemory(recentDecisions)}

【反馈循环 · 最近一次交易表现】
${formatFeedback(tradeHistory)}

【任务要求】
1. 结合裸K、量价结构、ATR 波动率、资金费率与盘口压差，自主判断每个币种的趋势、结构与动能；
2. 针对每个币种输出：多/空观点、入场与退出思路、风险控制（含仓位、杠杆、止盈止损逻辑），必要时说明观望理由；
3. 若需要执行操作，请使用工具调用（例如 openPosition/closePosition/getMarketPrice/getOrderBook/getPositions/getAccountBalance/calculateRisk 等），并明确参数；
4. 每次决策后请自我复盘，指出上一轮成功/失败的原因及本轮调整。

请保持输出结构化，先列宏观观察，再逐币种分析，最后给出执行计划与需要调用的工具。`;

  return prompt;
}

export function createHybridAutonomousAgent(intervalMinutes: number = 5) {
  const openai = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY || "",
    baseURL: process.env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1",
  });

  const memory = new Memory({
    storage: new LibSQLMemoryAdapter({
      url: "file:./.voltagent/hybrid-memory.db",
      logger: logger.child({ component: "libsql" }),
    }),
  });

  const instructions = generateSystemInstructions(intervalMinutes);

  const agent = new Agent({
    name: "hybrid-autonomous-agent",
    instructions,
    model: openai.chat(process.env.AI_MODEL_NAME || "deepseek/deepseek-v3.2-exp"),
    tools: [
      tradingTools.getMarketPriceTool,
      tradingTools.getTechnicalIndicatorsTool,
      tradingTools.getFundingRateTool,
      tradingTools.getOrderBookTool,
      tradingTools.openPositionTool,
      tradingTools.closePositionTool,
      tradingTools.cancelOrderTool,
      tradingTools.getAccountBalanceTool,
      tradingTools.getPositionsTool,
      tradingTools.getOpenOrdersTool,
      tradingTools.checkOrderStatusTool,
      tradingTools.calculateRiskTool,
      tradingTools.syncPositionsTool,
    ],
    memory,
  });

  return agent;
}
