import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenAI } from "@ai-sdk/openai";
import { Agent, Memory } from "@voltagent/core";
import { LibSQLMemoryAdapter } from "@voltagent/libsql";
import { createPinoLogger } from "@voltagent/logger";
import type { LevelWithSilent } from "pino";
import { RISK_PARAMS } from "../config/riskParams";
import { getTradingLoopConfig } from "../config/tradingLoop";
import type {
	FourHourMarketDataset,
	MarketEnvironmentSnapshot,
	PromptCandle,
} from "../services/fourHourAgent/dataCollector";
import * as tradingTools from "../tools/trading";
import type { MarketPulseEvent } from "../types/marketPulse";
import { describeMarketPulseEvent } from "../utils/marketPulseUtils";
import { formatChinaTime } from "../utils/timeUtils";
import type { DefenseLevelType } from "../services/lowFrequencyAgent/defenseLevels";

const logger = createPinoLogger({
	name: "four-hour-agent",
	level: (process.env.LOG_LEVEL || "info") as LevelWithSilent,
});

const DEFAULT_SYSTEM_TEMPLATE_PATH = "system_prompt_template.txt";
const SECTION_SEPARATOR = "⸻";
const CSV_HEADER = "idx,open,high,low,close,volume";


interface PromptAccountSnapshot {
	balance: number;
	available: number;
	drawdownPercent: number;
}

interface PromptPositionSnapshot {
	symbol: string;
	side: "long" | "short";
	entryPrice: number;
	marketPrice: number;
	pnlPercent: number;
	peakPnlPercent: number;
	holdHours: number;
	leverage: number;
	batchCount: number;
}

interface TradingAccountSnapshot {
	totalBalance?: number;
	availableBalance?: number;
	peakBalance?: number;
}

interface RawPositionLike {
	symbol?: string;
	contract?: string;
	side?: string;
	entry_price?: number | string;
	entryPrice?: number | string;
	current_price?: number | string;
	marketPrice?: number | string;
	markPrice?: number | string;
	pnl_percent?: number | string;
	pnlPercent?: number | string;
	peak_pnl_percent?: number | string;
	peakPnlPercent?: number | string;
	opened_at?: string;
	openedAt?: string;
	leverage?: number | string;
	batchCount?: number | string;
}

export interface FourHourPromptInput {
	accountInfo: TradingAccountSnapshot;
	positions: RawPositionLike[];
	dataset: FourHourMarketDataset;
	iteration: number;
	minutesElapsed: number;
	intervalMinutes: number;
	triggerReason?: "scheduled" | "market-pulse" | "defense-breach";
	marketPulseEvent?: MarketPulseEvent | null;
	defenseBreachContext?: DefenseBreachContext | null;
}

export interface DefenseBreachContext {
	symbol: string;
	side: "long" | "short";
	levelType: DefenseLevelType;
	levelPrice: number;
	currentPrice: number;
}

function loadTemplate(templatePath: string): string {
	const absolutePath = resolve(process.cwd(), templatePath);
	return readFileSync(absolutePath, "utf8");
}

function buildPromptAccount(
	accountInfo: TradingAccountSnapshot,
): PromptAccountSnapshot {
	const balance = Number(accountInfo?.totalBalance ?? 0);
	const available = Number(accountInfo?.availableBalance ?? 0);
	const peak = Number(accountInfo?.peakBalance ?? balance);
	const rawDrawdown = peak > 0 ? ((peak - balance) / peak) * 100 : 0;
	const drawdownPercent = rawDrawdown > 0 ? rawDrawdown : 0;
	return {
		balance,
		available,
		drawdownPercent,
	};
}

function parseNumber(value: unknown, fallback = 0): number {
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : fallback;
	}
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : fallback;
	}
	return fallback;
}

function buildPromptPositions(
	positions: RawPositionLike[],
): PromptPositionSnapshot[] {
	const now = Date.now();
	return positions.map<PromptPositionSnapshot>((pos) => {
		const entryPrice =
			parseNumber(pos.entryPrice) || parseNumber(pos.entry_price);
		const marketPriceRaw =
			parseNumber(pos.marketPrice) ||
			parseNumber(pos.current_price) ||
			parseNumber(pos.markPrice);
		const marketPrice = Number.isFinite(marketPriceRaw) ? marketPriceRaw : 0;
		const pnlPercent = parseNumber(pos.pnlPercent, Number.NaN);
		const normalizedPnlPercent = Number.isFinite(pnlPercent)
			? pnlPercent
			: parseNumber(pos.pnl_percent, 0);
		const rawPeak = parseNumber(pos.peakPnlPercent, Number.NaN);
		const peakFromDb = parseNumber(pos.peak_pnl_percent, Number.NaN);
		const peakPnlPercent = Number.isFinite(rawPeak)
			? rawPeak
			: Number.isFinite(peakFromDb)
				? peakFromDb
				: normalizedPnlPercent;
		const openedAtRaw = pos.opened_at ?? pos.openedAt;
		const openedAtTs = openedAtRaw ? Date.parse(openedAtRaw) : Number.NaN;
		const holdHours =
			Number.isFinite(openedAtTs) && openedAtTs > 0
				? (now - openedAtTs) / 3_600_000
				: 0;
		const normalizedHoldHours = Number.isFinite(holdHours)
			? Number(holdHours.toFixed(2))
			: 0;
		const leverage = parseNumber(pos.leverage, 1);
		const side = (pos.side ?? "").toLowerCase() === "short" ? "short" : "long";
		const rawBatch = parseNumber(pos.batchCount, Number.NaN);
		const batchCount = Number.isFinite(rawBatch)
			? Math.max(1, Math.round(rawBatch))
			: 1;

		return {
			symbol: pos.symbol ?? pos.contract ?? "UNKNOWN",
			side,
			entryPrice,
			marketPrice,
			pnlPercent: normalizedPnlPercent,
			peakPnlPercent,
			holdHours: normalizedHoldHours,
			leverage,
			batchCount: Math.max(batchCount, 1),
		};
	});
}

function formatCandleSeries(candles: PromptCandle[]): string {
	if (!candles.length) {
		return "";
	}
	const rows = [CSV_HEADER];
	for (let i = 0; i < candles.length; i++) {
		const candle = candles[i];
		rows.push(
			[
				i,
				candle.open.toFixed(4),
				candle.high.toFixed(4),
				candle.low.toFixed(4),
				candle.close.toFixed(4),
				candle.volume.toFixed(0),
			].join(","),
		);
	}
	return rows.join("\n");
}

function renderFourHourUserPrompt(context: {
	timestamp: string;
	account: PromptAccountSnapshot;
	positions: PromptPositionSnapshot[];
	marketEnvironment: MarketEnvironmentSnapshot;
	marketPulseTrigger: boolean;
	symbols: string[];
	k: FourHourMarketDataset["k"];
	indicators: FourHourMarketDataset["indicators"];
	riskParams: typeof RISK_PARAMS;
	extraContext: string;
	intervalMinutes: number;
}): string {
	const {
		timestamp,
		account,
		positions,
		marketEnvironment,
		marketPulseTrigger,
		symbols,
		k,
		indicators,
		riskParams,
		extraContext,
		intervalMinutes,
	} = context;

	const { llmControlEnabled } = getTradingLoopConfig();
	const llm_defense_enabled =
		process.env.LOW_FREQ_DEFENSE_TOOL_ENABLED === "true";
	const lines: string[] = [];
	lines.push("---------------------------","");
	lines.push("本周期执行信息", "");
	lines.push(`执行时间：${timestamp}`);
	lines.push(`执行周期：每 ${intervalMinutes} 分钟`, "");
	lines.push(
		`市场脉冲触发器：${marketPulseTrigger ? "触发（提前执行）" : "未触发"}`,
	);
	lines.push(

		"若由行情剧烈波动触发提前执行，此处为 true。",

		"---------------------------",

	);
	lines.push("【账户状态】");
	lines.push(`账户净值：${account.balance} USDT`);
	lines.push(`可用资金：${account.available} USDT`);
	lines.push(`当前回撤：${account.drawdownPercent}%`);
	lines.push(`当前持仓数量：${positions.length}`);
	lines.push(
		`允许持仓上限：${riskParams.MAX_POSITIONS}`,

		"---------------------------",

	);
	lines.push("【当前持仓列表】", "");
	lines.push(positions.length === 0 ? "（当前无任何持仓）" : "", "");
	for (const position of positions) {
		lines.push(`▸ ${position.symbol}`);
		lines.push(`方向：${position.side}`);
		lines.push(`开仓价：${position.entryPrice}`);
		lines.push(`当前价：${position.marketPrice}`);
		lines.push(`盈亏：${position.pnlPercent}%`);
		lines.push(`峰值盈利（peak）：${position.peakPnlPercent}%`);
		lines.push(`持仓时长：${position.holdHours} 小时`);
		lines.push(`杠杆：${position.leverage}x`);
		lines.push(
			`批次：${position.batchCount}（加仓次数：${position.batchCount - 1}）`,
		);
		lines.push("");
	}
	lines.push(
		"---------------------------",
		"【市场环境标签（全局）】",
		`波动率：${marketEnvironment.volatility}`,
		`趋势环境：${marketEnvironment.trendEnvironment}`,
		`BTC 主导地位：${marketEnvironment.btcDominance}`,
		`资金费率环境：${marketEnvironment.fundingBias}`,
		`市场脉冲触发：${marketPulseTrigger}`,
		"---------------------------",
		"【多交易对市场数据（按交易对逐一提供）】",
		"所有数据按 最旧 → 最新 排列。",
		"每个 symbol 都有：30m / 4h / 1d + 技术指标（精简版）。",
		"---------------------------",
		`交易对数量：${symbols.length}`,

		SECTION_SEPARATOR,
	);

	for (const sym of symbols) {
		const csv30 = formatCandleSeries(k[sym]["30m"]);
		const csv4h = formatCandleSeries(k[sym]["4h"]);
		const csv1d = formatCandleSeries(k[sym]["1d"]);
		const stringify = (value: unknown) => JSON.stringify(value);
		lines.push(
	
			` ${sym}（${sym}）· 多周期行情数据`,
			"====================================================",
			"30m 数据",
			`K线数量：${k[sym]["30m"].length}`,
			"```csv",
			csv30 || "(暂无数据)",
			"```",
			"技术指标（30m）",
			"```json",
			stringify(indicators[sym]["30m"]),
			"```",
			"---------------------------",
			"4h 数据",
			`K线数量：${k[sym]["4h"].length}`,
			"```csv",
			csv4h || "(暂无数据)",
			"```",
			"技术指标（4h）",
			"```json",
			stringify(indicators[sym]["4h"]),
			"```",
			"---------------------------",
			"1d 数据",
			`K线数量：${k[sym]["1d"].length}`,
			"```csv",
			csv1d || "(暂无数据)",
			"```",
			"技术指标（1d）",
			"```json",
			stringify(indicators[sym]["1d"]),
			"```",
			"---------------------------",
		);
	}

	lines.push(
		"【数据说明（LLM 必须遵守）】",
		"你需要基于 每个币种独立分析趋势、结构与概率。",
		"---------------------------",
		"数据包含：",
		"纯 OHLCV K 线（30m / 4h / 1d）",
		"精简技术指标（EMA20/50, MACD, RSI14, Vol/AvgVol）",
		"当前持仓与盈亏情况",
		"全局市场环境（趋势/波动性）",
		"---------------------------",
		"你必须自行判断：",
		"趋势方向（多周期一致性）",
		"结构（HH/HL vs LH/LL）",
		"突破 or 假突破",
		"回调强弱（缩量/放量）",
		"通道、区间、楔形、震荡等结构",
		"RR（风险收益比）",
		"是否处于危险位置（如日线阻力）",
		"是否反转",
		"是否需要平仓",
		"是否值得开仓",
		"是否继续观望",
		"---------------------------",
		"【工具调用权限】",
		"本周期你有权限使用以下工具：",
		"openPosition(sym, side)（市价单）",
		"closePosition(sym)（全部平仓）",
		"closePosition(sym, percentage)（部分平仓）",
		"getAccountBalance",
		"getPositions",
		"getMarketPrice",
		"getOrderBook",
		"如果你选择不调用任何工具，即视为“观望”。",
		"---------------------------",
		"【你的任务（对每个交易对独立分析）】",
		"你必须对 每个 symbol 分别 输出：",
		"（1）市场结构分析",
		"多周期趋势方向",
		"高低点结构（HH/HL、LH/LL）",
		"关键阻力与支撑",
		"是否突破 / 假突破",
		"是否反转",
		"量能是否支持结构",
		"是否进入震荡区间",
		"是否具备趋势共振",
		"（2）决策理由",
		"说明你为什么选择：",
		"开多",
		"开空",
		"平仓",
		"或观望",
		"理由必须基于结构、趋势、量能、RR。",
		"（3）最终行为",
		"必须给出明确行为之一：",
		"调用 openPosition",
		"调用 closePosition",
		"调用 closePosition（部分）",
		"观望（不调用任何工具）",
		"你必须避免模糊表达。",
		"---------------------------",
		"【必须遵守的行为规范】",
		"每个交易对必须 独立评估、多独立决策",
		"不允许因为某个币强/弱就推论其他币同方向",
		"不允许无依据地开仓或平仓",
		"不允许忽略量能",
		"不允许忽略趋势一致性",
		"不允许忽略 RR",
		"不允许忽略震荡风险",
		"不允许做模糊判断",
	);
	if (llmControlEnabled) {
		lines.push(
			"必须在决策完成后调用工具设置下一次执行周期",
			"---------------------------",
		);
	} else {
		lines.push("---------------------------");
	}
	if(llm_defense_enabled){
		lines.push(
			"如果进行了开仓，你必须在开仓后，调用工具设置交易对突破点位",
			"---------------------------",
		);
	}

	return lines.join("\n");
}

export function generateFourHourPrompt(
	input: FourHourPromptInput,
): string {
	const {
		accountInfo,
		positions,
		dataset,
		iteration,
		minutesElapsed,
		intervalMinutes,
		triggerReason = "scheduled",
		marketPulseEvent = null,
		defenseBreachContext = null,
	} = input;

	const account = buildPromptAccount(accountInfo);
	const promptPositions = buildPromptPositions(positions);
	const currentTime = formatChinaTime();
	const market_pulse_trigger = triggerReason === "market-pulse";
	const pulseSummary = describeMarketPulseEvent(marketPulseEvent);
	const triggerNote = market_pulse_trigger
		? (pulseSummary ?? "⚡ 市场脉冲触发，本轮为提前执行。")
		: "常规调度执行。";
	const breachNote = defenseBreachContext
		? `⚠️ 系统级防守点位被突破：${defenseBreachContext.symbol} ${defenseBreachContext.side === "long" ? "多头" : "空头"} 的${defenseBreachContext.levelType === "entry" ? "入场失效价" : "趋势结构失效价"} (${defenseBreachContext.levelPrice.toFixed(4)}) 已被${defenseBreachContext.side === "long" ? "跌破" : "突破"}，最新价 ${defenseBreachContext.currentPrice.toFixed(4)}。`
		: "";
	const extendedContext = `${triggerNote}\n执行迭代 #${iteration}，系统已运行 ${minutesElapsed} 分钟（周期 ${intervalMinutes} 分钟）。${
		breachNote ? `\n${breachNote}` : ""
	}`;

	return renderFourHourUserPrompt({
		timestamp: currentTime,
		account,
		positions: promptPositions,
		marketEnvironment: dataset.marketEnvironment,
		marketPulseTrigger: market_pulse_trigger,
		symbols: dataset.symbols,
		k: dataset.k,
		indicators: dataset.indicators,
		riskParams: RISK_PARAMS,
		extraContext: extendedContext,
		intervalMinutes,
	});
}

function getSystemPrompt(intervalMinutes = 60): string {
	const { llmControlEnabled } = getTradingLoopConfig();
	const llm_defense_enabled =
		process.env.LOW_FREQ_DEFENSE_TOOL_ENABLED === "true";
	return `
--------
你是一名 世界级职业加密货币交易员，擅长多周期趋势跟随、结构识别、风险管理与概率交易。
你每 4 小时 接收一次最新市场数据，并必须做出专业、独立、不偏向任何方向的交易决策。
你可以使用以下工具（tool call）：
 . openPosition
 . closePosition
 . getPositions
 . getAccountBalance
 . getMarketPrice
 . getOrderBook
 . setDefenseLevels
 . set_next_trading_cycle_interval
如果本周期没有足够高质量的机会，你可以选择不调用任何工具（=观望）。
--------
【你的交易哲学】
你不是机器人，你不会机械化执行策略。
你像一个真正的交易员一样基于结构 → 趋势 → 量能 → 关键位 → RR → 市场环境 做判断。
你的核心原则：
1.大周期优先
2.趋势优先于指标
3.结构优先于单根 K 线
4.量能决定突破真假
5.关键位决定 RR（风险收益比）
6.顺势优先，逆势谨慎
7.震荡区间减少交易
你不以“做多/做空”为偏好，你的偏好只有一个：
胜率高的机会。
--------
【你将收到的数据】
用户会提供以下信息：
1. 多周期 K 线（裸 K）
按“最旧 → 最新”排列：
 . 30m：60 根
 . 4h：90 根
 . 1d：60 根
2. 每周期的关键精简指标
 . EMA20 / EMA50
 . MACD（value / signal / histogram）
 . RSI14
 . 成交量（当前 vs 过去20根平均）
3. 持仓信息（如有）
方向、开仓价、持仓时长、pnl%、peak_pnl%、杠杆
4. 账户状态
 . balance
 . available
 . drawdown
5. 市场环境标签（系统提供）
如：
 . volatility: high / normal / low
 . trend_environment: up / down / ranging
 . btc_dominance: rising / falling
 . funding_rate: positive / negative
 . market_pulse_trigger: true/false（脉冲触发）
6. 工具权限
本周期允许哪些操作（开多/开空/平仓等）
--------
【必须执行的分析任务】
你必须对每个交易对执行：
1. 多周期趋势分析
 . 30m 是否代表短期趋势？
 . 4h 是否代表主趋势？
 . 1d 是否代表大级别趋势？
趋势必须明确（up / down / ranging）。
2. 结构分析
判断：
 . HH / HL 上升结构
 . LH / LL 下跌结构
 . 假突破 / 假跌破
 . 双底 / 双顶
 . 反转 K 线（吞没、锤子、流星、插针）
 . 是否在通道 / 区间内部
3. 量价关系
 . 推进是否放量？
 . 回调是否缩量？
 . 突破是否有效？
4. RR（风险收益比）评估
判断：
 . 止损位是否合理？
 . 目标区间是否可实现？
 . RR ≥ 2 才可考虑进场。
5. 持仓管理（如有）
你必须判断：
 . 趋势是否健康？
 . 结构是否被破坏？
 . 是否接近关键阻力/支撑？
 . 是否需要平仓？
--------
【必须遵守的多空对称规则】
你必须对每个交易对计算：
 . 做多信号强度（0-10）
 . 做空信号强度（0-10）
 . 观望信号强度（0-10）
你不能只说“不适合做多”或"不适合做空"。
必须同时评估：
✔ 是否适合做多
✔ 是否适合做空
✔ 是否适合观望
你的最终决策必须根据三者排序。
--------
【进场要求（多空对称）】
以下条件必须全部满足才能开仓：
1.至少两个周期趋势一致（如 4h + 1d）
2.出现明确结构突破 / 跌破
3.量能配合突破
4.非震荡区间中段
5.RR ≥ 2
6.有可量化的结构止损点位
额外增强信号：
 . 反方向已出现失败结构（假突破）
 . 大级别趋势共振
 . 接近合理拐点区间
--------
${llm_defense_enabled ?
`
【防守设置（必须执行）】
若你决定开仓，你必须立即调用：
setDefenseLevels(
  entry_invalidation = 数值,
  structure_invalidation = 数值
)
解释规则：
entry_invalidation
 . 来自 30m / 4h 的最近结构失败位（最近高点或低点）
structure_invalidation
 . 来自 4h / 1d 的更大级别结构破坏位
 . 告诉系统“趋势被毁掉了必须唤醒我”
这是你作为职业交易员的核心工作。
`:``}
--------
【平仓条件】
你必须主动平仓如果：
 . 趋势出现大级别反转
 . 结构破坏
 . 多周期背离出现
 . 接近主要阻力/支撑
 . 量能突然枯竭
 . RR 已经失衡
 . 盈利回撤超过 30–40%
 . 市场进入混乱震荡
--------
【观望条件】
必须观望的情况：
 . 信号分歧（30m vs 4h vs 1d）
 . 震荡无方向
 . 量能不足
 . 无合理止损
 . 高风险低回报
 . 关键位附近的噪音区
你作为职业交易员必须避免“硬开仓”。
--------
【输出格式（必须遵守）】
你必须输出：
--------
1. 市场结构分析（专业，但简洁）
包括：
 . 多周期趋势
 . 结构（HH/HL, LH/LL）
-通道、区间
 . 关键位
 . 量能
 . 反转信号
 . 震荡与否
--------
2. 决策理由
必须解释：
-为何方向成立
-为何不是另外两个方向
-为何 RR 合理
-为何结构健康
-为何量能支持
--------
3. 实际行为（工具调用）
你必须选择以下之一：
1.openPosition(side=“long”)
2.openPosition(side=“short”)
3.closePosition(symbol)
4.不调用任何工具 → 观望
${llm_defense_enabled ?
`
若开仓 → 必须紧接着调用
setDefenseLevels(...)
`:``}
--------
【你的最终目标】
作为世界级交易员，你的最终使命：
用尽可能少的交易，抓住最大概率的趋势行情，避免震荡中的亏损。
你的优先级：
1.趋势健康度
2.结构一致性
3.RR 合理性
4.量能确认
5.市场环境
越少的交易 → 越高的胜率。
--------
	`;
}

export function createFourHourAgent(intervalMinutes = 60) {
	const openai = createOpenAI({
		apiKey: process.env.OPENAI_API_KEY || "",
		baseURL: process.env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1",
	});

	const memory = new Memory({
		storage: new LibSQLMemoryAdapter({
			url: "file:./.voltagent/four-hour-memory.db",
			logger: logger.child({ component: "libsql" }),
		}),
	});

	const templatePath =
		process.env.FOUR_HOUR_SYSTEM_TEMPLATE_PATH?.trim() ||
		DEFAULT_SYSTEM_TEMPLATE_PATH;
	const useCustomTemplate =
		Boolean(process.env.FOUR_HOUR_SYSTEM_TEMPLATE_PATH) &&
		templatePath.length > 0;
	const systemPrompt = useCustomTemplate
		? loadTemplate(templatePath)
		: getSystemPrompt(intervalMinutes);

	const agent = new Agent({
		name: "four-hour-agent",
		instructions: systemPrompt,
		model: openai.chat(
			process.env.AI_MODEL_NAME || "deepseek/deepseek-v3.2-exp",
		),
		tools: [
			tradingTools.getMarketPriceTool,
			tradingTools.getOrderBookTool,
			tradingTools.getAccountBalanceTool,
			tradingTools.getPositionsTool,
			tradingTools.openPositionTool,
			tradingTools.closePositionTool,
			tradingTools.setDefenseLevelsTool,
			tradingTools.setNextTradingCycleIntervalTool,
		],
		memory,
	});

	logger.info(`4小时低频交易 Agent 已初始化（调度周期 ${intervalMinutes} 分钟）。`);

	return agent;
}
