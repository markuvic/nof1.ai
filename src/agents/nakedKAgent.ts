import { Agent, Memory } from "@voltagent/core";
import { LibSQLMemoryAdapter } from "@voltagent/libsql";
import { createPinoLogger } from "@voltagent/logger";
import { createOpenAI } from "@ai-sdk/openai";
import * as tradingTools from "../tools/trading";
import {
	getAccountRiskConfig,
	getStrategyParams,
	getTradingStrategy,
	TradingStrategy,
} from "./tradingAgent";
import type { KlineEntry } from "../services/marketDataCache";
import type { NakedKDataset } from "../services/marketData/nakedKCollector";
import { formatChinaTime } from "../utils/timeUtils";
import { RISK_PARAMS } from "../config/riskParams";
import type { MarketPulseEvent } from "../types/marketPulse";
import { describeMarketPulseEvent } from "../utils/marketPulseUtils";

const logger = createPinoLogger({
	name: "naked-k-agent",
	level: "info",
});

export interface NakedKPromptInput {
	minutesElapsed: number;
	iteration: number;
	intervalMinutes: number;
	nakedKData: Record<string, NakedKDataset>;
	accountInfo: any;
	positions: any[];
	tradeHistory?: any[];
	recentDecisions?: any[];
	triggerReason?: "scheduled" | "market-pulse" | "defense-breach";
	marketPulseEvent?: MarketPulseEvent | null;
}

function formatCandleSeries(candles: KlineEntry[]): string {
	if (!candles.length) {
		return "";
	}
	const rows = ["idx,open,high,low,close,vol"];
	const baseLength = candles.length;
	for (let i = 0; i < baseLength; i++) {
		const candle = candles[i];
		const open = Number(candle.open.toFixed(3));
		const high = Number(candle.high.toFixed(3));
		const low = Number(candle.low.toFixed(3));
		const close = Number(candle.close.toFixed(3));
		const volume = Number(candle.volume.toFixed(1));
		rows.push(`${i},${open},${high},${low},${close},${volume}`);
	}
	return rows.join("\n");
}

function formatPositions(positions: any[]): string {
	if (!positions || positions.length === 0) {
		return "当前无持仓。\n";
	}
	return positions
		.map((pos) => {
			const sideText = pos.side === "long" ? "做多" : "做空";
			const entryPrice = Number.parseFloat(
				pos.entryPrice || pos.entry_price || "0",
			);
			const currentPrice = Number.parseFloat(
				pos.markPrice || pos.current_price || "0",
			);
			const unrealized = Number.parseFloat(
				pos.unrealisedPnl || pos.unrealized_pnl || "0",
			);
			const rawPercent =
				entryPrice > 0
					? ((currentPrice - entryPrice) / entryPrice) *
						100 *
						(pos.side === "long" ? 1 : -1)
					: 0;
			const pnlPercent = Number.isFinite(pos.pnl_percent)
				? Number(pos.pnl_percent)
				: rawPercent * (pos.leverage || 1);
			return `• ${pos.symbol} ${sideText} ${pos.quantity} 张 @ ${entryPrice.toFixed(2)}（现价 ${currentPrice.toFixed(2)}，杠杆 ${pos.leverage || "-"}x，未实现盈亏 ${unrealized.toFixed(2)} USDT，杠杆盈亏 ${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(2)}%，原始价格变动 ${rawPercent >= 0 ? "+" : ""}${rawPercent.toFixed(2)}%）`;
		})
		.join("\n")
		.concat("\n");
}

function formatTradeHistory(trades: any[] = []): string {
	if (!trades || trades.length === 0) {
		return "暂无历史交易记录。\n";
	}
	return trades
		.slice(0, 10)
		.map((trade) => {
			const time = formatChinaTime(
				trade.timestamp || trade.time || trade.created_at,
			);
			const sideText =
				trade.side === "long" || trade.side === "BUY" ? "做多" : "做空";
			const pnl =
				trade.pnl !== undefined && trade.pnl !== null
					? `${trade.pnl >= 0 ? "+" : ""}${Number(trade.pnl).toFixed(2)} USDT`
					: "—";
			return `• ${time} ${trade.symbol} ${sideText} ${trade.type} @ ${Number(trade.price).toFixed(2)} (${pnl})`;
		})
		.join("\n")
		.concat("\n");
}

export function generateNakedKPrompt(data: NakedKPromptInput): string {
	const {
		minutesElapsed,
		iteration,
		intervalMinutes,
		nakedKData,
		accountInfo,
		positions,
		tradeHistory,
		recentDecisions,
		triggerReason = "scheduled",
		marketPulseEvent = null,
	} = data;

	const currentTime = formatChinaTime();
	const strategy = getTradingStrategy();
	const params = getStrategyParams(strategy);
	const pulseSummary = describeMarketPulseEvent(marketPulseEvent);
	const triggerNote =
		triggerReason === "market-pulse"
			? (pulseSummary ??
				"⚡ 市场脉冲触发：裸K Agent 需要针对突发行情马上复盘关键时间框架。")
			: "本轮为常规调度执行。";

	const profileId = Object.values(nakedKData)[0]?.profileId ?? "baseline";

	let prompt = `【裸K 交易周期 #${iteration}】${currentTime}
已运行 ${minutesElapsed} 分钟，执行周期 ${intervalMinutes} 分钟

${triggerNote}

当前策略：${params.name}（${params.description}）
使用裸K 数据配置：${profileId}

【风险控制原则】
- 单笔最大亏损 ≤ ${params.stopLoss.low}% (${params.stopLoss.low}/${params.stopLoss.mid}/${params.stopLoss.high})
- 峰值回撤保护：${params.peakDrawdownProtection}%
- 持仓时间 ≥ 36 小时自动评估是否平仓
- 波动性调节：${JSON.stringify(params.volatilityAdjustment)}

【账户状态】
- 净值：${Number(accountInfo.totalBalance).toFixed(2)} USDT
- 可用资金：${Number(accountInfo.availableBalance).toFixed(2)} USDT
- 未实现盈亏：${Number(accountInfo.unrealisedPnl).toFixed(2)} USDT
- 收益率：${Number(accountInfo.returnPercent).toFixed(2)}%

【当前持仓】
${formatPositions(positions)}
`;

	const symbols = Object.keys(nakedKData).sort();
	prompt += "【裸K 数据（按时间从旧到新，格式：[时间,开,高,低,收,量]）】\n";
	for (const symbol of symbols) {
		const dataset = nakedKData[symbol];
		prompt += `\n### ${symbol}\n`;
		const frames = Object.entries(dataset.frames);
		for (const [interval, frameData] of frames) {
			prompt += `- Interval ${interval}（最新 ${frameData.candles.length} 根）\n`;
			const csv = formatCandleSeries(frameData.candles);
			if (csv) {
				prompt += "```csv\n";
				prompt += `${csv}\n`;
				prompt += "```\n";
			} else {
				prompt += "（暂无可用K线数据）\n";
			}
		}
	}

	// prompt += "\n【历史交易概览】\n";
	// prompt += formatTradeHistory(tradeHistory);

	// if (recentDecisions && recentDecisions.length > 0) {
	//   prompt += "\n【上一轮 AI 决策摘要】\n";
	//   const recent = recentDecisions[0];
	//   prompt += `${formatChinaTime(recent.timestamp)} - ${recent.decision}\n`;
	// }

	// 历史成交记录（最近10条）
	if (tradeHistory && tradeHistory.length > 0) {
		prompt += `\n最近交易历史（最近10笔交易，最旧 → 最新）：\n`;
		prompt += `重要说明：以下仅为最近10条交易的统计，用于分析近期策略表现，不代表账户总盈亏。\n`;
		prompt += `使用此信息评估近期交易质量、识别策略问题、优化决策方向。\n\n`;

		let totalProfit = 0;
		let profitCount = 0;
		let lossCount = 0;

		for (const trade of tradeHistory) {
			const tradeTime = formatChinaTime(trade.timestamp);

			prompt += `交易: ${trade.symbol} ${trade.type === "open" ? "开仓" : "平仓"} ${trade.side.toUpperCase()}\n`;
			prompt += `  时间: ${tradeTime}\n`;
			prompt += `  价格: ${trade.price.toFixed(2)}, 数量: ${trade.quantity.toFixed(4)}, 杠杆: ${trade.leverage}x\n`;
			prompt += `  手续费: ${trade.fee.toFixed(4)} USDT\n`;

			// 对于平仓交易，总是显示盈亏金额
			if (trade.type === "close") {
				if (trade.pnl !== undefined && trade.pnl !== null) {
					prompt += `  盈亏: ${trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)} USDT\n`;
					totalProfit += trade.pnl;
					if (trade.pnl > 0) {
						profitCount++;
					} else if (trade.pnl < 0) {
						lossCount++;
					}
				} else {
					prompt += `  盈亏: 暂无数据\n`;
				}
			}

			prompt += `\n`;
		}

		if (profitCount > 0 || lossCount > 0) {
			const winRate = (profitCount / (profitCount + lossCount)) * 100;
			prompt += `最近10条交易统计（仅供参考）:\n`;
			prompt += `  - 胜率: ${winRate.toFixed(1)}%\n`;
			prompt += `  - 盈利交易: ${profitCount}笔\n`;
			prompt += `  - 亏损交易: ${lossCount}笔\n`;
			prompt += `  - 最近10条净盈亏: ${totalProfit >= 0 ? "+" : ""}${totalProfit.toFixed(2)} USDT\n`;
			prompt += `\n注意：此数值仅为最近10笔交易统计，用于评估近期策略有效性，不是账户总盈亏。\n`;
			prompt += `账户真实盈亏请参考上方"当前账户状态"中的收益率和总资产变化。\n\n`;
		}
	}

	// 上一次的AI决策记录（仅供参考，不是当前状态）
	if (recentDecisions && recentDecisions.length > 0) {
		prompt += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
		prompt += `【历史决策记录 - 仅供参考】\n`;
		prompt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
		prompt += `⚠️ 重要提醒：以下是历史决策记录，仅作为参考，不代表当前状态！\n`;
		prompt += `当前市场数据和持仓信息请参考上方实时数据。\n\n`;

		for (let i = 0; i < recentDecisions.length; i++) {
			const decision = recentDecisions[i];
			const decisionTime = formatChinaTime(decision.timestamp);
			const timeDiff = Math.floor(
				(new Date().getTime() - new Date(decision.timestamp).getTime()) /
					(1000 * 60),
			);

			prompt += `【历史】决策 #${decision.iteration} (${decisionTime}，${timeDiff}分钟前):\n`;
			prompt += `  当时账户价值: ${decision.account_value.toFixed(2)} USDT\n`;
			prompt += `  当时持仓数量: ${decision.positions_count}\n`;
			prompt += `  当时决策内容: ${decision.decision}\n\n`;
		}

		prompt += `\n💡 使用建议：\n`;
		prompt += `- 仅作为决策连续性参考，不要被历史决策束缚\n`;
		prompt += `- 市场已经变化，请基于当前最新数据独立判断\n`;
		prompt += `- 如果市场条件改变，应该果断调整策略\n\n`;
	}

	prompt += `
【任务说明】
1. 先检查持仓是否满足风控规则（止损/止盈/峰值回撤/持仓时长）。
2. 基于裸K 数据（各时间框架）判断多空趋势、关键支撑阻力、是否需要挂单、进入观望或执行交易。
3. 所有真实操作需调用工具（openPosition/closePosition/cancelOrder/getAccountBalance 等）。
4. 如果结论是观望，请明确说明原因（如趋势不明、成交量不足等）。
`;

	return prompt;
}

function buildBaseInstructions(
	strategy: TradingStrategy,
	intervalMinutes: number,
): string {
	const params = getStrategyParams(strategy);
	return `
  您是世界顶级的专业量化交易员，结合系统化方法与丰富的实战经验。  
当前执行【${params.name}】策略框架，使用 LLM 工具（tool call）直接执行交易操作。  
您在严格风控底线内拥有基于市场实际情况灵活调整的自主权。

---

## ⚙️ 系统说明（裸 K 版）

- 您通过“工具调用（tool call）”执行实际交易：openPosition、closePosition、getPositions、getAccountBalance、getMarketPrice、getOrderBook 等。
- **K 线数据（多时间框架、多个交易对）由用户提示词提供**，内容为按时间从旧到新排列的 OHLCV。不得要求或依赖任何技术指标（如 MA/RSI/MACD/BOLL 等）；若输入中出现此类指标字段，请**忽略**。
- 如果本周期 **不调用任何交易工具**，系统视为“观望”。观望是默认状态，只有在**结构明确、方向清晰**时才允许调用交易工具。
- 您必须能独立识别上涨（做多）与下跌（做空）趋势，并根据趋势方向选择操作。
- **每个交易对都必须独立分析、独立决策**。

---

## 🎯 您的身份与交易目标

- **顶级交易员**：15年量化交易实战经验，擅长多时间框架价格行为与结构分析。  
- **专业能力**：基于 K 线形态、结构（高低点/通道/区间/突破）、量能与概率思维决策。  
- **核心理念**：风险控制优先，精准出击。  
- **交易方向**：支持双向交易（多空皆可），不要只执着于某一个方向，多空都是赚钱的机会 
- **月回报目标**：${params.name === "稳健" ? "10-20%" : params.name === "平衡" ? "20-40%" : "40%+"}  
- **胜率** ≥60%，**盈亏比** ≥2.5:1。  

---

## 当前交易规则（${params.name}策略）

- 您交易的加密货币永续合约包括：${RISK_PARAMS.TRADING_SYMBOLS.join("、")}  
- 每个交易对必须独立进行**完整的裸 K 分析**与决策。  
- **仅使用市价单**，即时执行（不使用挂单）。  
- 同一币种不能同时持有多头与空头仓位（禁止对冲）。  
- 加仓与减仓规则适用于每个独立币种。  
- 系统会在每 ${intervalMinutes} 分钟自动提供所有交易对的最新 **K 线数据**（多时间框架）。
- 你的交易目标主要是中短线交易,优先关注并使用【5m,15m】的K线数据进行【主要】分析,【1h,4h】的K线数据进行【辅助】分析
- 只要趋势明确，条件足够，就可以进行交易
- 不要只做多，也不要只做空，只要其中一个方向趋势够强，分数够高，就可以进行交易
---

## 📊 多空信号强度与评分体系（基于价格行为）

每周期必须独立分析【每个交易对】的【做多】与【做空】两条路径：

| 等级 | 做多信号标准（示例） | 做空信号标准（示例） |
|------|----------------------|----------------------|
| **A+（强）** | ≥2 个周期结构**一致抬高**（Higher High/Higher Low）；突破关键阻力并**有效站稳**；突破/上攻时**放量**；出现强势延续/吞没/圆弧上拱等形态，回撤**缩量** | ≥2 个周期结构**一致下移**（Lower High/Lower Low）；跌破关键支撑并**有效站稳**；下破/下压时**放量**；顶部吞没/上影线密集/台阶式下行，反弹**缩量** |
| **B（中）** | 2 个周期同向但结构或量能确认不足；靠近强阻力位 | 2 个周期同向但结构或量能确认不足；靠近强支撑位 |
| **C（弱）** | 周期分歧/盘整/假突破概率高 | 周期分歧/盘整/假跌破概率高 |

**双向评分（0–100，各方向各算一套）**
- 趋势结构（0–20）：高低点序列/通道是否清晰一致  
- 关键位（0–20）：是否**有效**突破/跌破并回测确认  
- K 线动能（0–20）：实体/影线/连续性（上攻长实体、回撤小实体/下影等）  
- 量价关系（0–20）：推进放量、回撤缩量；假突破常见“放量冲高回落/上影长”  
- 风险收益（0–20）：目标/止损的可实现性与 RR≥2.5  
→ 70+ = A+，60–69 = B，<60 = C

> **超卖/超买概念不使用**；在强趋势中，影线与量价比“指标信号”更可靠。  
> **顺势优先**：若 5m/15m 结构明确下行，优先寻找做空；反之亦然。

---

## 🧭 决策闸门与优先级（裸 K 版）

- **做多开仓条件**：bull_score ≥ 70 且 bull_score - bear_score ≥ 5 且 RR≥2.0  
- **做空开仓条件**：bear_score ≥ 70 且 bear_score - bull_score ≥ 5 且 RR≥2.0  
- **加仓条件**：方向一致、已有盈利 > 5%、本周期信号较上周期**增强 ≥10 分**（结构/量能进一步有利）  
- **观望条件**：两个方向趋势都不足，两个方向都不满足任何闸门 → **不调用任何交易工具**  
- **顺序优先**：先管持仓（止损/止盈/反转），再评估新仓；**先平后反**。

---

## 🧠 多交易对分析流程（每 ${intervalMinutes} 分钟执行）

### Step 1️⃣ 检查账户状态
- getAccountBalance 获取账户净值；  
- getPositions 获取当前持仓列表；  
- 若账户回撤 ≥ ${params.peakDrawdownProtection}% → 全局观望。  

### Step 2️⃣ 针对每个交易对执行以下流程（必须逐个分析）
对每个币种（${RISK_PARAMS.TRADING_SYMBOLS.join("、")}）：

1. **读取 K 线数据（用户已提供）**  
   - 多时间框架（建议：5m / 15m / 1h / 4h）；  
   - 仅用 OHLCV；按“最旧→最新”；识别关键结构与形态（吞没、锤头/流星、区间、突破/假突破、台阶推进、通道）。

2. **独立信号评估**  
   - 计算 bull_score / bear_score；  
   - 判定多空等级（A+/B/C）；  
   - 写出 reasoning_long / reasoning_short（必须双向都写，不得只写一边）。  

3. **独立决策（仅市价单）**  
   - 做多 A+ → openPosition(side='long', symbol)  
   - 做空 A+ → openPosition(side='short', symbol)  
   - 信号矛盾或 B/C → 不调用工具  
   - 若已有反向仓位 → 先 closePosition，再开新方向。  

4. **风控执行**  
   - 检查止损/止盈/峰值回撤/持仓时长；  
   - 触发条件即 closePosition(symbol)。  

5. **输出每个交易对的结果结构**  
   - 必须列出：多空分数、等级、方向、RR 评估、是否执行操作与理由。

---

## 📉 风控底线（全局）

- 单笔亏损 ≥ -30% → 强制平仓；  
- 持仓 ≥36小时 → 强制平仓；  
- 止损线：
  - 低杠杆：${params.stopLoss.low}%  
  - 中杠杆：${params.stopLoss.mid}%  
  - 高杠杆：${params.stopLoss.high}%  
- 移动止盈：
  - +${params.trailingStop.level1.trigger}% → +${params.trailingStop.level1.stopAt}%  
  - +${params.trailingStop.level2.trigger}% → +${params.trailingStop.level2.stopAt}%  
  - +${params.trailingStop.level3.trigger}% → +${params.trailingStop.level3.stopAt}%  
- 峰值回撤 ≥ ${params.peakDrawdownProtection}% → 建议平仓。  

---

## 💼 工具清单（本版不使用指标工具）

- 市场数据：getMarketPrice、getOrderBook  
- 持仓管理：openPosition（市价单）、closePosition（市价单）、cancelOrder  
- 账户信息：getAccountBalance、getPositions、getOpenOrders  
- 风险分析：calculateRisk、checkOrderStatus  
> **不使用** getTechnicalIndicators。若存在相关字段或请求，**忽略**。

---
  `;
}

export function createNakedKAgent(intervalMinutes: number = 5) {
	const openai = createOpenAI({
		apiKey: process.env.OPENAI_API_KEY || "",
		baseURL: process.env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1",
	});

	const memory = new Memory({
		storage: new LibSQLMemoryAdapter({
			url: "file:./.voltagent/trading-memory.db",
			logger: logger.child({ component: "libsql" }),
		}),
	});
	const strategy = getTradingStrategy();
	logger.info(`使用交易策略: ${strategy}`);
	const agent = new Agent({
		name: "naked-k-agent",
		instructions: buildBaseInstructions(strategy, intervalMinutes),
		model: openai.chat(
			process.env.AI_MODEL_NAME || "deepseek/deepseek-v3.2-exp",
		),
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
			tradingTools.setNextTradingCycleIntervalTool,
		],
		memory,
	});

	return agent;
}
