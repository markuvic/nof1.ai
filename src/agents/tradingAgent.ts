/**
 * open-nof1.ai - AI 加密货币自动交易系统
 * Copyright (C) 2025 195440
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * 交易 Agent 配置（极简版）
 */
import { Agent, Memory } from "@voltagent/core";
import { LibSQLMemoryAdapter } from "@voltagent/libsql";
import { createPinoLogger } from "@voltagent/logger";
import { createOpenAI } from "@ai-sdk/openai";
import * as tradingTools from "../tools/trading";
import { formatChinaTime } from "../utils/timeUtils";
import { RISK_PARAMS } from "../config/riskParams";
import type { MarketPulseEvent } from "../types/marketPulse";
import { describeMarketPulseEvent } from "../utils/marketPulseUtils";

/**
 * 账户风险配置
 */
export interface AccountRiskConfig {
	stopLossUsdt: number;
	takeProfitUsdt: number;
	syncOnStartup: boolean;
}

/**
 * 从环境变量读取账户风险配置
 */
export function getAccountRiskConfig(): AccountRiskConfig {
	return {
		stopLossUsdt: Number.parseFloat(process.env.ACCOUNT_STOP_LOSS_USDT || "50"),
		takeProfitUsdt: Number.parseFloat(
			process.env.ACCOUNT_TAKE_PROFIT_USDT || "10000",
		),
		syncOnStartup: process.env.SYNC_CONFIG_ON_STARTUP === "true",
	};
}

/**
 * 交易策略类型
 */
export type TradingStrategy =
	| "conservative"
	| "balanced"
	| "aggressive"
	| "ultra-short"
	| "swing-trend";

/**
 * 策略参数配置
 */
export interface StrategyParams {
	name: string;
	description: string;
	leverageMin: number;
	leverageMax: number;
	leverageRecommend: {
		normal: string;
		good: string;
		strong: string;
	};
	positionSizeMin: number;
	positionSizeMax: number;
	positionSizeRecommend: {
		normal: string;
		good: string;
		strong: string;
	};
	stopLoss: {
		low: number;
		mid: number;
		high: number;
	};
	trailingStop: {
		// 移动止盈阶梯配置 [触发盈利, 移动止损线]
		level1: { trigger: number; stopAt: number };
		level2: { trigger: number; stopAt: number };
		level3: { trigger: number; stopAt: number };
	};
	partialTakeProfit: {
		// 分批止盈配置（根据策略杠杆调整）
		stage1: { trigger: number; closePercent: number }; // 第一阶段：平仓50%
		stage2: { trigger: number; closePercent: number }; // 第二阶段：平仓剩余50%
		stage3: { trigger: number; closePercent: number }; // 第三阶段：全部清仓
	};
	peakDrawdownProtection: number; // 峰值回撤保护阈值（百分比）
	volatilityAdjustment: {
		// 波动率调整系数
		highVolatility: { leverageFactor: number; positionFactor: number }; // ATR > 5%
		normalVolatility: { leverageFactor: number; positionFactor: number }; // ATR 2-5%
		lowVolatility: { leverageFactor: number; positionFactor: number }; // ATR < 2%
	};
	entryCondition: string;
	riskTolerance: string;
	tradingStyle: string;
}

/**
 * 获取策略参数（基于 MAX_LEVERAGE 动态计算）
 */
export function getStrategyParams(strategy: TradingStrategy): StrategyParams {
	const maxLeverage = RISK_PARAMS.MAX_LEVERAGE;

	// 根据 MAX_LEVERAGE 动态计算各策略的杠杆范围
	// 保守策略：30%-60% 的最大杠杆
	const conservativeLevMin = Math.max(1, Math.ceil(maxLeverage * 0.3));
	const conservativeLevMax = Math.max(2, Math.ceil(maxLeverage * 0.6));
	const conservativeLevNormal = conservativeLevMin;
	const conservativeLevGood = Math.ceil(
		(conservativeLevMin + conservativeLevMax) / 2,
	);
	const conservativeLevStrong = conservativeLevMax;

	// 平衡策略：60%-85% 的最大杠杆
	// const balancedLevMin = Math.max(2, Math.ceil(maxLeverage * 0.6));
	// const balancedLevMax = Math.max(3, Math.ceil(maxLeverage * 0.85));
	// const balancedLevNormal = balancedLevMin;
	// const balancedLevGood = Math.ceil((balancedLevMin + balancedLevMax) / 2);
	// const balancedLevStrong = balancedLevMax;
	const balancedLevMin = maxLeverage;
	const balancedLevMax = maxLeverage;
	const balancedLevNormal = maxLeverage;
	const balancedLevGood = maxLeverage;
	const balancedLevStrong = maxLeverage;

	// 激进策略：85%-100% 的最大杠杆
	const aggressiveLevMin = Math.max(3, Math.ceil(maxLeverage * 0.85));
	const aggressiveLevMax = maxLeverage;
	const aggressiveLevNormal = aggressiveLevMin;
	const aggressiveLevGood = Math.ceil(
		(aggressiveLevMin + aggressiveLevMax) / 2,
	);
	const aggressiveLevStrong = aggressiveLevMax;

	const strategyConfigs: Record<TradingStrategy, StrategyParams> = {
		"ultra-short": {
			name: "超短线",
			description: "极短周期快进快出，5分钟执行，适合高频交易",
			leverageMin: Math.max(3, Math.ceil(maxLeverage * 0.5)),
			leverageMax: Math.max(5, Math.ceil(maxLeverage * 0.75)),
			leverageRecommend: {
				normal: `${Math.max(3, Math.ceil(maxLeverage * 0.5))}倍`,
				good: `${Math.max(4, Math.ceil(maxLeverage * 0.625))}倍`,
				strong: `${Math.max(5, Math.ceil(maxLeverage * 0.75))}倍`,
			},
			positionSizeMin: 18,
			positionSizeMax: 25,
			positionSizeRecommend: {
				normal: "18-20%",
				good: "20-23%",
				strong: "23-25%",
			},
			stopLoss: {
				low: -2.5,
				mid: -2,
				high: -1.5,
			},
			trailingStop: {
				// 超短线策略：快速锁利（5分钟周期）
				level1: { trigger: 4, stopAt: 1.5 }, // 盈利达到 +4% 时，止损线移至 +1.5%
				level2: { trigger: 8, stopAt: 4 }, // 盈利达到 +8% 时，止损线移至 +4%
				level3: { trigger: 15, stopAt: 8 }, // 盈利达到 +15% 时，止损线移至 +8%
			},
			partialTakeProfit: {
				// 超短线策略：快速分批止盈
				stage1: { trigger: 15, closePercent: 50 }, // +15% 平仓50%
				stage2: { trigger: 25, closePercent: 50 }, // +25% 平仓剩余50%
				stage3: { trigger: 35, closePercent: 100 }, // +35% 全部清仓
			},
			peakDrawdownProtection: 20, // 超短线：20%峰值回撤保护（快速保护利润）
			volatilityAdjustment: {
				highVolatility: { leverageFactor: 0.7, positionFactor: 0.8 },
				normalVolatility: { leverageFactor: 1.0, positionFactor: 1.0 },
				lowVolatility: { leverageFactor: 1.1, positionFactor: 1.0 },
			},
			entryCondition: "至少2个时间框架信号一致，优先1-5分钟级别",
			riskTolerance: "单笔交易风险控制在18-25%之间，快进快出",
			tradingStyle:
				"超短线交易，5分钟执行周期，快速捕捉短期波动，严格执行2%周期锁利规则和30分钟盈利平仓规则",
		},
		"swing-trend": {
			name: "波段趋势",
			description: "中长线波段交易，20分钟执行，捕捉中期趋势，适合稳健成长",
			leverageMin: Math.max(2, Math.ceil(maxLeverage * 0.2)),
			leverageMax: Math.max(5, Math.ceil(maxLeverage * 0.5)),
			leverageRecommend: {
				normal: `${Math.max(2, Math.ceil(maxLeverage * 0.2))}倍`,
				good: `${Math.max(3, Math.ceil(maxLeverage * 0.35))}倍`,
				strong: `${Math.max(5, Math.ceil(maxLeverage * 0.5))}倍`,
			},
			positionSizeMin: 12,
			positionSizeMax: 20,
			positionSizeRecommend: {
				normal: "12-15%",
				good: "15-18%",
				strong: "18-20%",
			},
			stopLoss: {
				low: -10, // 低杠杆(2-3倍)：-10%止损（给趋势足够空间）
				mid: -8, // 中杠杆(3-4倍)：-8%止损
				high: -6, // 高杠杆(4-5倍)：-6%止损
			},
			trailingStop: {
				// 波段策略：给趋势更多空间，较晚锁定利润
				level1: { trigger: 15, stopAt: 8 }, // 盈利达到 +15% 时，止损线移至 +8%
				level2: { trigger: 30, stopAt: 20 }, // 盈利达到 +30% 时，止损线移至 +20%
				level3: { trigger: 50, stopAt: 35 }, // 盈利达到 +50% 时，止损线移至 +35%
			},
			partialTakeProfit: {
				// 波段策略：更晚分批止盈，追求趋势利润最大化
				stage1: { trigger: 50, closePercent: 40 }, // +50% 平仓40%（保留60%追求更大利润）
				stage2: { trigger: 80, closePercent: 60 }, // +80% 平仓剩余60%（累计平仓100%）
				stage3: { trigger: 120, closePercent: 100 }, // +120% 全部清仓
			},
			peakDrawdownProtection: 35, // 波段策略：35%峰值回撤保护（给趋势更多空间）
			volatilityAdjustment: {
				highVolatility: { leverageFactor: 0.5, positionFactor: 0.6 }, // 高波动：大幅降低风险
				normalVolatility: { leverageFactor: 1.0, positionFactor: 1.0 }, // 正常波动：标准配置
				lowVolatility: { leverageFactor: 1.2, positionFactor: 1.1 }, // 低波动：适度提高（趋势稳定）
			},
			entryCondition:
				"至少3个以上时间框架信号强烈一致，优先15分钟-4小时级别，等待明确趋势形成",
			riskTolerance: "单笔交易风险控制在12-20%之间，注重趋势质量而非交易频率",
			tradingStyle:
				"波段趋势交易，20分钟执行周期，耐心等待高质量趋势信号，持仓时间可达数天，让利润充分奔跑",
		},
		conservative: {
			name: "稳健",
			description: "低风险低杠杆，严格入场条件，适合保守投资者",
			leverageMin: conservativeLevMin,
			leverageMax: conservativeLevMax,
			leverageRecommend: {
				normal: `${conservativeLevNormal}倍`,
				good: `${conservativeLevGood}倍`,
				strong: `${conservativeLevStrong}倍`,
			},
			positionSizeMin: 15,
			positionSizeMax: 22,
			positionSizeRecommend: {
				normal: "15-17%",
				good: "17-20%",
				strong: "20-22%",
			},
			stopLoss: {
				low: -3.5,
				mid: -3,
				high: -2.5,
			},
			trailingStop: {
				// 保守策略：较早锁定利润（基准：15倍杠杆）
				// 注意：这些是基准值，实际使用时会根据杠杆动态调整
				level1: { trigger: 6, stopAt: 2 }, // 基准：盈利达到 +6% 时，止损线移至 +2%
				level2: { trigger: 12, stopAt: 6 }, // 基准：盈利达到 +12% 时，止损线移至 +6%
				level3: { trigger: 20, stopAt: 12 }, // 基准：盈利达到 +20% 时，止损线移至 +12%
			},
			partialTakeProfit: {
				// 保守策略：较早分批止盈，提前锁定利润
				stage1: { trigger: 20, closePercent: 50 }, // +20% 平仓50%
				stage2: { trigger: 30, closePercent: 50 }, // +30% 平仓剩余50%
				stage3: { trigger: 40, closePercent: 100 }, // +40% 全部清仓
			},
			peakDrawdownProtection: 25, // 保守策略：25%峰值回撤保护（更早保护利润）
			volatilityAdjustment: {
				highVolatility: { leverageFactor: 0.6, positionFactor: 0.7 }, // 高波动：大幅降低
				normalVolatility: { leverageFactor: 1.0, positionFactor: 1.0 }, // 正常波动：不调整
				lowVolatility: { leverageFactor: 1.0, positionFactor: 1.0 }, // 低波动：不调整（保守不追求）
			},
			entryCondition: "至少3个关键时间框架信号一致，4个或更多更佳",
			riskTolerance: "单笔交易风险控制在15-22%之间，严格控制回撤",
			tradingStyle: "谨慎交易，宁可错过机会也不冒险，优先保护本金",
		},
		balanced: {
			name: "平衡",
			description: "中等风险杠杆，合理入场条件，适合大多数投资者",
			leverageMin: balancedLevMin,
			leverageMax: balancedLevMax,
			leverageRecommend: {
				normal: `${balancedLevNormal}倍`,
				good: `${balancedLevGood}倍`,
				strong: `${balancedLevStrong}倍`,
			},
			positionSizeMin: 20,
			positionSizeMax: 27,
			positionSizeRecommend: {
				normal: "20-23%",
				good: "23-25%",
				strong: "25-27%",
			},
			stopLoss: {
				low: -3,
				mid: -2.5,
				high: -2,
			},
			trailingStop: {
				// 平衡策略：适中的移动止盈（基准：15倍杠杆）
				// 注意：这些是基准值，实际使用时会根据杠杆动态调整
				level1: { trigger: 8, stopAt: 3 }, // 基准：盈利达到 +8% 时，止损线移至 +3%
				level2: { trigger: 15, stopAt: 8 }, // 基准：盈利达到 +15% 时，止损线移至 +8%
				level3: { trigger: 25, stopAt: 15 }, // 基准：盈利达到 +25% 时，止损线移至 +15%
			},
			partialTakeProfit: {
				// 平衡策略：标准分批止盈
				stage1: { trigger: 30, closePercent: 50 }, // +30% 平仓50%
				stage2: { trigger: 40, closePercent: 50 }, // +40% 平仓剩余50%
				stage3: { trigger: 50, closePercent: 100 }, // +50% 全部清仓
			},
			peakDrawdownProtection: 30, // 平衡策略：30%峰值回撤保护（标准平衡点）
			volatilityAdjustment: {
				highVolatility: { leverageFactor: 1.0, positionFactor: 1.0 }, // 高波动：适度降低
				normalVolatility: { leverageFactor: 1.0, positionFactor: 1.0 }, // 正常波动：不调整
				lowVolatility: { leverageFactor: 1.1, positionFactor: 1.0 }, // 低波动：略微提高杠杆
			},
			entryCondition: "至少3个关键时间框架信号一致，3个以上更佳",
			riskTolerance: "单笔交易风险控制在20-27%之间，平衡风险与收益",
			tradingStyle: "在风险可控前提下积极把握机会，追求稳健增长",
		},
		aggressive: {
			name: "激进",
			description: "高风险高杠杆，宽松入场条件，适合激进投资者",
			leverageMin: aggressiveLevMin,
			leverageMax: aggressiveLevMax,
			leverageRecommend: {
				normal: `${aggressiveLevNormal}倍`,
				good: `${aggressiveLevGood}倍`,
				strong: `${aggressiveLevStrong}倍`,
			},
			positionSizeMin: 25,
			positionSizeMax: 32,
			positionSizeRecommend: {
				normal: "25-28%",
				good: "28-30%",
				strong: "30-32%",
			},
			stopLoss: {
				low: -2.5,
				mid: -2,
				high: -1.5,
			},
			trailingStop: {
				// 激进策略：更晚锁定，追求更高利润（基准：15倍杠杆）
				// 注意：这些是基准值，实际使用时会根据杠杆动态调整
				level1: { trigger: 10, stopAt: 4 }, // 基准：盈利达到 +10% 时，止损线移至 +4%
				level2: { trigger: 18, stopAt: 10 }, // 基准：盈利达到 +18% 时，止损线移至 +10%
				level3: { trigger: 30, stopAt: 18 }, // 基准：盈利达到 +30% 时，止损线移至 +18%
			},
			partialTakeProfit: {
				// 激进策略：更晚分批止盈，追求更高利润
				stage1: { trigger: 40, closePercent: 50 }, // +40% 平仓50%
				stage2: { trigger: 50, closePercent: 50 }, // +50% 平仓剩余50%
				stage3: { trigger: 60, closePercent: 100 }, // +60% 全部清仓
			},
			peakDrawdownProtection: 35, // 激进策略：35%峰值回撤保护（给利润更多奔跑空间）
			volatilityAdjustment: {
				highVolatility: { leverageFactor: 0.8, positionFactor: 0.85 }, // 高波动：轻微降低
				normalVolatility: { leverageFactor: 1.0, positionFactor: 1.0 }, // 正常波动：不调整
				lowVolatility: { leverageFactor: 1.2, positionFactor: 1.1 }, // 低波动：提高杠杆和仓位
			},
			entryCondition: "至少2个关键时间框架信号一致即可入场",
			riskTolerance: "单笔交易风险可达25-32%，追求高收益",
			tradingStyle: "积极进取，快速捕捉市场机会，追求最大化收益",
		},
	};

	return strategyConfigs[strategy];
}

const logger = createPinoLogger({
	name: "trading-agent",
	level: "info",
});

/**
 * 从环境变量读取交易策略
 */
export function getTradingStrategy(): TradingStrategy {
	const strategy = process.env.TRADING_STRATEGY || "balanced";
	if (
		strategy === "conservative" ||
		strategy === "balanced" ||
		strategy === "aggressive" ||
		strategy === "ultra-short" ||
		strategy === "swing-trend"
	) {
		return strategy;
	}
	logger.warn(`未知的交易策略: ${strategy}，使用默认策略: balanced`);
	return "balanced";
}

/**
 * 生成交易提示词（参照 1.md 格式）
 */
export function generateTradingPrompt(data: {
	minutesElapsed: number;
	iteration: number;
	intervalMinutes: number;
	marketData: any;
	accountInfo: any;
	positions: any[];
	tradeHistory?: any[];
	recentDecisions?: any[];
	triggerReason?: "scheduled" | "market-pulse" | "defense-breach";
	marketPulseEvent?: MarketPulseEvent | null;
}): string {
	const {
		minutesElapsed,
		iteration,
		intervalMinutes,
		marketData,
		accountInfo,
		positions,
		tradeHistory,
		recentDecisions,
		triggerReason = "scheduled",
		marketPulseEvent = null,
	} = data;
	const currentTime = formatChinaTime();
	const pulseSummary = describeMarketPulseEvent(marketPulseEvent);
	const triggerNote =
		triggerReason === "market-pulse"
			? (pulseSummary ??
				"⚡ 市场脉冲触发：请针对突发行情快速响应，并说明防守计划。")
			: "本轮为常规调度执行。";

	// 获取当前策略参数（用于每周期强调风控规则）
	const strategy = getTradingStrategy();
	const params = getStrategyParams(strategy);

	let prompt = `【交易周期 #${iteration}】${currentTime}
已运行 ${minutesElapsed} 分钟，执行周期 ${intervalMinutes} 分钟

${triggerNote}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
当前策略：${params.name}（${params.description}）
目标月回报：${params.name === "稳健" ? "10-20%" : params.name === "平衡" ? "20-40%" : "40%+"}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【硬性风控底线 - 系统强制执行】
┌─────────────────────────────────────────┐
│ 单笔亏损 ≤ -30%：强制平仓               │
│ 持仓时间 ≥ 36小时：强制平仓             │
└─────────────────────────────────────────┘

【AI战术决策 - 强烈建议遵守】
┌─────────────────────────────────────────┐
│ 策略止损：${params.stopLoss.low}% ~ ${params.stopLoss.high}%（根据杠杆）│
│ 移动止盈：                               │
│   • 盈利≥+${params.trailingStop.level1.trigger}% → 止损移至+${params.trailingStop.level1.stopAt}%  │
│   • 盈利≥+${params.trailingStop.level2.trigger}% → 止损移至+${params.trailingStop.level2.stopAt}%  │
│   • 盈利≥+${params.trailingStop.level3.trigger}% → 止损移至+${params.trailingStop.level3.stopAt}% │
│ 分批止盈：                               │
│   • 盈利≥+${params.partialTakeProfit.stage1.trigger}% → 平仓${params.partialTakeProfit.stage1.closePercent}%  │
│   • 盈利≥+${params.partialTakeProfit.stage2.trigger}% → 平仓${params.partialTakeProfit.stage2.closePercent}%  │
│   • 盈利≥+${params.partialTakeProfit.stage3.trigger}% → 平仓${params.partialTakeProfit.stage3.closePercent}% │
│ 峰值回撤：≥${params.peakDrawdownProtection}% → 危险信号，立即平仓 │
└─────────────────────────────────────────┘

【决策流程 - 按优先级执行】
(1) 持仓管理（最优先）：
   检查每个持仓的止损/止盈/峰值回撤 → closePosition
   
(2) 新开仓评估：
   分析市场数据 → 识别双向机会（做多/做空） → openPosition
   
(3) 加仓评估：
   盈利>5%且趋势强化 → openPosition（≤50%原仓位，相同或更低杠杆）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【数据说明】
本提示词已预加载所有必需数据：
• 所有币种的市场数据和技术指标（多时间框架）
• 账户信息（余额、收益率、夏普比率）
• 当前持仓状态（盈亏、持仓时间、杠杆）
• 历史交易记录（最近10笔）

【您的任务】
直接基于上述数据做出交易决策，无需重复获取数据：
1. 分析持仓管理需求（止损/止盈/加仓）→ 调用 closePosition / openPosition 执行
2. 识别新交易机会（做多/做空）→ 调用 openPosition 执行
3. 评估风险和仓位管理 → 调用 calculateRisk 验证

关键：您必须实际调用工具执行决策，不要只停留在分析阶段！

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

以下所有价格或信号数据按时间顺序排列：最旧 → 最新

时间框架说明：除非在章节标题中另有说明，否则日内序列以 3 分钟间隔提供。如果某个币种使用不同的间隔，将在该币种的章节中明确说明。

所有币种的当前市场状态
`;

	// 按照 1.md 格式输出每个币种的数据
	for (const [symbol, dataRaw] of Object.entries(marketData)) {
		const data = dataRaw as any;

		prompt += `\n所有 ${symbol} 数据\n`;
		prompt += `当前价格 = ${data.price.toFixed(1)}, 当前EMA20 = ${data.ema20.toFixed(3)}, 当前MACD = ${data.macd.toFixed(3)}, 当前RSI（7周期） = ${data.rsi7.toFixed(3)}\n\n`;

		// 资金费率
		if (data.fundingRate !== undefined) {
			prompt += `此外，这是 ${symbol} 永续合约的最新资金费率（您交易的合约类型）：\n\n`;
			prompt += `资金费率: ${data.fundingRate.toExponential(2)}\n\n`;
		}

		// 日内时序数据（3分钟级别）
		if (data.intradaySeries && data.intradaySeries.midPrices.length > 0) {
			const series = data.intradaySeries;
			prompt += `日内序列（按分钟，最旧 → 最新）：\n\n`;

			// Mid prices
			prompt += `中间价: [${series.midPrices.map((p: number) => p.toFixed(1)).join(", ")}]\n\n`;

			// EMA indicators (20‑period)
			prompt += `EMA指标（20周期）: [${series.ema20Series.map((e: number) => e.toFixed(3)).join(", ")}]\n\n`;

			// MACD indicators
			prompt += `MACD指标: [${series.macdSeries.map((m: number) => m.toFixed(3)).join(", ")}]\n\n`;

			// RSI indicators (7‑Period)
			prompt += `RSI指标（7周期）: [${series.rsi7Series.map((r: number) => r.toFixed(3)).join(", ")}]\n\n`;

			// RSI indicators (14‑Period)
			prompt += `RSI指标（14周期）: [${series.rsi14Series.map((r: number) => r.toFixed(3)).join(", ")}]\n\n`;
		}

		// 更长期的上下文数据（1小时级别 - 用于短线交易）
		if (data.longerTermContext) {
			const ltc = data.longerTermContext;
			prompt += `更长期上下文（1小时时间框架）：\n\n`;

			prompt += `20周期EMA: ${ltc.ema20.toFixed(2)} vs. 50周期EMA: ${ltc.ema50.toFixed(2)}\n\n`;

			if (ltc.atr3 && ltc.atr14) {
				prompt += `3周期ATR: ${ltc.atr3.toFixed(2)} vs. 14周期ATR: ${ltc.atr14.toFixed(3)}\n\n`;
			}

			prompt += `当前成交量: ${ltc.currentVolume.toFixed(2)} vs. 平均成交量: ${ltc.avgVolume.toFixed(3)}\n\n`;

			// MACD 和 RSI 时序（4小时，最近10个数据点）
			if (ltc.macdSeries && ltc.macdSeries.length > 0) {
				prompt += `MACD指标: [${ltc.macdSeries.map((m: number) => m.toFixed(3)).join(", ")}]\n\n`;
			}

			if (ltc.rsi14Series && ltc.rsi14Series.length > 0) {
				prompt += `RSI指标（14周期）: [${ltc.rsi14Series.map((r: number) => r.toFixed(3)).join(", ")}]\n\n`;
			}
		}

		// 多时间框架指标数据
		if (data.timeframes) {
			prompt += `多时间框架指标：\n\n`;

			const tfList = [
				{ key: "1m", name: "1分钟" },
				{ key: "3m", name: "3分钟" },
				{ key: "5m", name: "5分钟" },
				{ key: "15m", name: "15分钟" },
				{ key: "30m", name: "30分钟" },
				{ key: "1h", name: "1小时" },
			];

			for (const tf of tfList) {
				const tfData = data.timeframes[tf.key];
				if (tfData) {
					prompt += `${tf.name}: 价格=${tfData.currentPrice.toFixed(2)}, EMA20=${tfData.ema20.toFixed(3)}, EMA50=${tfData.ema50.toFixed(3)}, MACD=${tfData.macd.toFixed(3)}, RSI7=${tfData.rsi7.toFixed(2)}, RSI14=${tfData.rsi14.toFixed(2)}, 成交量=${tfData.volume.toFixed(2)}\n`;
				}
			}
			prompt += `\n`;
		}
	}

	// 账户信息和表现（参照 1.md 格式）
	prompt += `\n以下是您的账户信息和表现\n`;

	// 计算账户回撤（如果提供了初始净值和峰值净值）
	if (
		accountInfo.initialBalance !== undefined &&
		accountInfo.peakBalance !== undefined
	) {
		const drawdownFromPeak =
			((accountInfo.peakBalance - accountInfo.totalBalance) /
				accountInfo.peakBalance) *
			100;
		const drawdownFromInitial =
			((accountInfo.initialBalance - accountInfo.totalBalance) /
				accountInfo.initialBalance) *
			100;

		prompt += `初始账户净值: ${accountInfo.initialBalance.toFixed(2)} USDT\n`;
		prompt += `峰值账户净值: ${accountInfo.peakBalance.toFixed(2)} USDT\n`;
		prompt += `当前账户价值: ${accountInfo.totalBalance.toFixed(2)} USDT\n`;
		prompt += `账户回撤 (从峰值): ${drawdownFromPeak >= 0 ? "" : "+"}${(-drawdownFromPeak).toFixed(2)}%\n`;
		prompt += `账户回撤 (从初始): ${drawdownFromInitial >= 0 ? "" : "+"}${(-drawdownFromInitial).toFixed(2)}%\n\n`;

		// 添加风控警告（使用配置参数）
		// 注释：已移除强制清仓限制，仅保留警告提醒
		if (drawdownFromPeak >= RISK_PARAMS.ACCOUNT_DRAWDOWN_WARNING_PERCENT) {
			prompt += `提醒: 账户回撤已达到 ${drawdownFromPeak.toFixed(2)}%，请谨慎交易\n\n`;
		}
	} else {
		prompt += `当前账户价值: ${accountInfo.totalBalance.toFixed(2)} USDT\n\n`;
	}

	prompt += `当前总收益率: ${accountInfo.returnPercent.toFixed(2)}%\n\n`;

	// 计算所有持仓的未实现盈亏总和
	const totalUnrealizedPnL = positions.reduce(
		(sum, pos) => sum + (pos.unrealized_pnl || 0),
		0,
	);

	prompt += `可用资金: ${accountInfo.availableBalance.toFixed(1)} USDT\n\n`;
	prompt += `未实现盈亏: ${totalUnrealizedPnL.toFixed(2)} USDT (${totalUnrealizedPnL >= 0 ? "+" : ""}${((totalUnrealizedPnL / accountInfo.totalBalance) * 100).toFixed(2)}%)\n\n`;

	// 当前持仓和表现
	if (positions.length > 0) {
		prompt += `以下是您当前的持仓信息。重要说明：\n`;
		prompt += `- “杠杆盈亏百分比” 已帮您乘以杠杆，直接代表保证金盈亏幅度\n`;
		prompt += `- 例如：10倍杠杆，价格上涨0.5%，则盈亏百分比 = +5%（保证金增值5%）\n`;
		prompt += `- 括号内的“原始价格变动”仅供对照，不包含杠杆\n`;
		prompt += `- 请以系统提供的“杠杆盈亏百分比”为准，不要自己重新计算\n\n`;
		for (const pos of positions) {
			// 计算盈亏百分比：考虑杠杆倍数
			// 对于杠杆交易：盈亏百分比 = (价格变动百分比) × 杠杆倍数
			const priceChangePercent =
				pos.entry_price > 0
					? ((pos.current_price - pos.entry_price) / pos.entry_price) *
						100 *
						(pos.side === "long" ? 1 : -1)
					: 0;
			const pnlPercent = priceChangePercent * pos.leverage;

			// 计算持仓时长
			const openedTime = new Date(pos.opened_at);
			const now = new Date();
			const holdingMinutes = Math.floor(
				(now.getTime() - openedTime.getTime()) / (1000 * 60),
			);
			const holdingHours = (holdingMinutes / 60).toFixed(1);
			const remainingHours = Math.max(0, 36 - parseFloat(holdingHours));
			const holdingCycles = Math.floor(holdingMinutes / intervalMinutes); // 根据实际执行周期计算
			const maxCycles = Math.floor((36 * 60) / intervalMinutes); // 36小时的总周期数
			const remainingCycles = Math.max(0, maxCycles - holdingCycles);

			prompt += `当前活跃持仓: ${pos.symbol} ${pos.side === "long" ? "做多" : "做空"}\n`;
			prompt += `  杠杆倍数: ${pos.leverage}x\n`;
			prompt += `  杠杆盈亏百分比: ${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(2)}%\n`;
			prompt += `  原始价格变动: ${priceChangePercent >= 0 ? "+" : ""}${priceChangePercent.toFixed(2)}%（未乘杠杆，仅供对照）\n`;
			prompt += `  盈亏金额: ${pos.unrealized_pnl >= 0 ? "+" : ""}${pos.unrealized_pnl.toFixed(2)} USDT\n`;
			prompt += `  开仓价: ${pos.entry_price.toFixed(2)}\n`;
			prompt += `  当前价: ${pos.current_price.toFixed(2)}\n`;
			prompt += `  开仓时间: ${formatChinaTime(pos.opened_at)}\n`;
			prompt += `  已持仓: ${holdingHours} 小时 (${holdingMinutes} 分钟, ${holdingCycles} 个周期)\n`;
			prompt += `  距离36小时限制: ${remainingHours.toFixed(1)} 小时 (${remainingCycles} 个周期)\n`;

			// 如果接近36小时,添加警告
			if (remainingHours < 2) {
				prompt += `  警告: 即将达到36小时持仓限制,必须立即平仓!\n`;
			} else if (remainingHours < 4) {
				prompt += `  提醒: 距离36小时限制不足4小时,请准备平仓\n`;
			}

			prompt += "\n";
		}
	}

	// Sharpe Ratio
	if (accountInfo.sharpeRatio !== undefined) {
		prompt += `夏普比率: ${accountInfo.sharpeRatio.toFixed(3)}\n\n`;
	}

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

	// 上一次的AI决策记录
	if (recentDecisions && recentDecisions.length > 0) {
		prompt += `\n您上一次的决策：\n`;
		prompt += `使用此信息作为参考，并基于当前市场状况做出决策。\n\n`;

		for (let i = 0; i < recentDecisions.length; i++) {
			const decision = recentDecisions[i];
			const decisionTime = formatChinaTime(decision.timestamp);

			prompt += `决策 #${decision.iteration} (${decisionTime}):\n`;
			prompt += `  账户价值: ${decision.account_value.toFixed(2)} USDT\n`;
			prompt += `  持仓数量: ${decision.positions_count}\n`;
			prompt += `  决策: ${decision.decision}\n\n`;
		}

		prompt += `\n参考上一次的决策结果，结合当前市场数据做出最佳判断。\n\n`;
	}

	return prompt;
}

/**
 * 根据策略生成交易指令
 */
function generateInstructions(
	strategy: TradingStrategy,
	intervalMinutes: number,
): string {
	const params = getStrategyParams(strategy);

	return `
  您是世界顶级的专业量化交易员，结合系统化方法与丰富的实战经验。  
当前执行【${params.name}】策略框架，使用 LLM 工具（tool call）直接执行交易操作。  
您在严格风控底线内拥有基于市场实际情况灵活调整的自主权。

---

## ⚙️ 系统说明

- 您通过“工具调用（tool call）”执行实际交易：openPosition、closePosition、getPositions、getAccountBalance、getTechnicalIndicators 等。
- 如果本周期 **不调用任何交易工具**，系统视为“观望”。
- 观望是默认状态，只有在信号明确、趋势共振、方向确定时，才允许调用交易工具。
- 您必须能独立识别上涨（做多）与下跌（做空）趋势，并根据趋势方向选择操作。
- 每个交易对都必须独立分析、独立决策。

---

## 🎯 您的身份与交易目标

- **顶级交易员**：15年量化交易实战经验，擅长多时间框架分析与系统交易。  
- **专业能力**：基于技术指标、价格结构、量能和概率思维决策。  
- **核心理念**：风险控制优先，精准出击。  
- **交易方向**：支持双向交易（多空皆可）。  
- **月回报目标**：${params.name === "稳健" ? "10-20%" : params.name === "平衡" ? "20-40%" : "40%+"}  
- **胜率** ≥60%，**盈亏比** ≥2.5:1。  

---

## 当前交易规则（${params.name}策略）

- 您交易的加密货币永续合约包括：${RISK_PARAMS.TRADING_SYMBOLS.join("、")}  
- 每个交易对必须独立进行完整分析与决策。  
- 仅使用市价单，即时执行。  
- 同一币种不能同时持有多头与空头仓位（禁止对冲）。  
- 加仓与减仓规则适用于每个独立币种。  
- 系统会在每 ${intervalMinutes} 分钟自动提供所有交易对的最新指标数据。

---

## 📊 多空信号强度与评分体系

每周期必须独立分析【每个交易对】的【做多】与【做空】两条路径：

| 等级 | 做多信号标准 | 做空信号标准 |
|------|---------------|---------------|
| **A+（强）** | ≥3周期共振上行；价格上破关键阻力；MA(20/50/200)多头排列；MACD>0金叉扩张；RSI>55；放量上攻 | ≥3周期共振下行；价格下破关键支撑；MA(20/50/200)空头排列；MACD<0死叉扩张；RSI<45；放量下跌 |
| **B（中）** | 2周期方向一致但动能不足或量能不足 | 同上 |
| **C（弱）** | 周期分歧、震荡、无方向 | 周期分歧、震荡、无方向 |

> **超卖 ≠ 做多信号**；若主趋势下行，应优先考虑顺势做空。  

### 信号评分（0–100，各方向独立）
- 趋势结构：0–20  
- 关键位突破/跌破：0–20  
- 动能（MACD/RSI）：0–20  
- 量价配合：0–20  
- 风险收益比：0–20  
→ 75+ = A+，60–74 = B，<60 = C  

---

## 🧭 决策闸门与优先级

- **做多开仓条件**：bull_score ≥ 75 且 bull_score - bear_score ≥ 10 且 RR≥2.5  
- **做空开仓条件**：bear_score ≥ 75 且 bear_score - bull_score ≥ 10 且 RR≥2.5  
- **加仓条件**：方向一致、已有盈利>5%、信号增强≥10分  
- **观望条件**：不满足任何闸门 → 不调用任何交易工具  
- **顺势优先**：若1h/4h主趋势下行 → 优先空头；若上行 → 优先多头。  

---

## 🧠 多交易对分析流程（每${intervalMinutes}分钟执行）

### Step 1 检查账户状态
- getAccountBalance 获取账户净值；  
- getPositions 获取当前持仓列表；  
- 若账户回撤 ≥ ${params.peakDrawdownProtection}% → 全局观望。  

### Step 2 针对每个交易对执行以下流程（必须逐个分析）

对每个币种（${RISK_PARAMS.TRADING_SYMBOLS.join("、")}）：

1. **获取最新技术指标**  
   - 调用 getTechnicalIndicators(symbol)；  
   - 分析多周期趋势（15m / 30m / 1h / 4h）；  
   - 提取价格、EMA、MACD、RSI、成交量。

2. **独立信号评估**  
   - 计算 bull_score、bear_score；  
   - 判定多空信号等级（A+/B/C）；  
   - 写出 reasoning_long 与 reasoning_short。

3. **独立决策**  
   - 若做多信号 A+ → openPosition(side='long', symbol)  
   - 若做空信号 A+ → openPosition(side='short', symbol)  
   - 若信号矛盾或B/C级 → 不调用任何工具  
   - 若已有反向仓位 → 先 closePosition，再开反向仓。  

4. **风控执行**  
   - 检查止损/止盈/峰值回撤；
   - 触发条件即 closePosition(symbol)。

5. **输出每个交易对的结果结构**  
   - 必须列出每个交易对的信号评分、等级、方向、是否执行操作。

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

`;
}

/**
 * 创建交易 Agent
 */
export function createTradingAgent(intervalMinutes: number = 5) {
	// 使用 OpenAI SDK，通过配置 baseURL 兼容 OpenRouter 或其他供应商
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

	// 获取当前策略
	const strategy = getTradingStrategy();
	logger.info(`使用交易策略: ${strategy}`);
	const prompt = generateInstructions(strategy, intervalMinutes);
	//logger.info(prompt);
	const agent = new Agent({
		name: "trading-agent",
		instructions: prompt,
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
