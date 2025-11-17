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
	MidFrequencyMarketDataset,
	MidFrequencySymbolSnapshot,
	MidFrequencyTimeframe,
} from "../services/midFrequencyAgent/dataCollector";
import type { PromptCandle } from "../services/lowFrequencyAgent/dataCollector";
import * as tradingTools from "../tools/trading";
import type { MarketPulseEvent } from "../types/marketPulse";
import { describeMarketPulseEvent } from "../utils/marketPulseUtils";
import { formatChinaTime } from "../utils/timeUtils";

const logger = createPinoLogger({
	name: "mid-frequency-agent",
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

export interface MidFrequencyPromptInput {
	accountInfo: TradingAccountSnapshot;
	positions: RawPositionLike[];
	dataset: MidFrequencyMarketDataset;
	iteration: number;
	minutesElapsed: number;
	intervalMinutes: number;
	triggerReason?: "scheduled" | "market-pulse" | "defense-breach";
	marketPulseEvent?: MarketPulseEvent | null;
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

function renderSymbolSection(
	symbol: string,
	data: MidFrequencySymbolSnapshot,
): string {
	const lines: string[] = [];
	lines.push(`[${symbol}]`);
	lines.push(`current_price: ${data.currentPrice.toFixed(4)}`);
	lines.push("funding_rate:");
	lines.push(`  now: ${(data.fundingRate.now * 100).toFixed(4)}%`);
	lines.push(`  8h_avg: ${(data.fundingRate.avg8h * 100).toFixed(4)}%`);
	lines.push("orderbook:");
	lines.push(`  bid_strength: ${data.orderbook.bid_strength.toFixed(2)}`);
	lines.push(`  ask_strength: ${data.orderbook.ask_strength.toFixed(2)}`);
	lines.push("volatility_snapshot:");
	lines.push(`  volume_now_5m: ${data.volumeSnapshot.volume_now_5m.toFixed(0)}`);
	lines.push(`  volume_avg_5m: ${data.volumeSnapshot.volume_avg_5m.toFixed(0)}`);
	lines.push(
		`  volume_now_15m: ${data.volumeSnapshot.volume_now_15m.toFixed(0)}`,
	);
	lines.push(
		`  volume_avg_15m: ${data.volumeSnapshot.volume_avg_15m.toFixed(0)}`,
	);
	lines.push("atr:");
	lines.push(`  atr_5m: ${data.atr.atr_5m.toFixed(4)}`);
	lines.push(`  atr_15m: ${data.atr.atr_15m.toFixed(4)}`);
	lines.push(`  atr_1h: ${data.atr.atr_1h.toFixed(4)}`);
	lines.push("rsi:");
	lines.push(`  rsi_7_15m: ${data.rsi.rsi_7_15m.toFixed(2)}`);
	lines.push(`  rsi_14_1h: ${data.rsi.rsi_14_1h.toFixed(2)}`);
	lines.push(`  rsi_14_4h: ${data.rsi.rsi_14_4h.toFixed(2)}`);
	lines.push("macd:");
	lines.push(`  macd_1h: ${data.macd.macd_1h.toFixed(4)}`);
	lines.push(`  signal_1h: ${data.macd.signal_1h.toFixed(4)}`);
	lines.push(`  hist_1h: ${data.macd.hist_1h.toFixed(4)}`);
	lines.push("trend_summary:");
	lines.push(`  5m: ${data.trendSummary["5m"]}`);
	lines.push(`  15m: ${data.trendSummary["15m"]}`);
	lines.push(`  1h: ${data.trendSummary["1h"]}`);
	lines.push(`  4h: ${data.trendSummary["4h"]}`);

	const timeframeOrder: MidFrequencyTimeframe[] = ["5m", "15m", "1h", "4h"];
	for (const tf of timeframeOrder) {
		const series = formatCandleSeries(data.candles[tf]);
		lines.push(`${tf} 裸K (${data.candles[tf].length} 根):`);
		lines.push(series || "无数据");
	}
	return lines.join("\n");
}

function renderMidFrequencyUserPrompt(context: {
	timestamp: string;
	account: PromptAccountSnapshot;
	positions: PromptPositionSnapshot[];
	dataset: MidFrequencyMarketDataset;
	marketPulseTrigger: boolean;
	iteration: number;
	minutesElapsed: number;
	intervalMinutes: number;
	triggerNote: string;
}): string {
	const {
		timestamp,
		account,
		positions,
		dataset,
		marketPulseTrigger,
		iteration,
		minutesElapsed,
		intervalMinutes,
		triggerNote,
	} = context;

	const lines: string[] = [];
	lines.push("【时间与调度】");
	lines.push(
		`| 循环 #${iteration} | 已运行 ${minutesElapsed} 分钟 | 周期 ${intervalMinutes} 分钟`,
	);
	lines.push(triggerNote);
	lines.push(marketPulseTrigger ? "⚡ 市场脉冲强制触发" : "常规调度");
	lines.push("【账户状态】");
	lines.push(`账户净值：${account.balance} USDT`);
	lines.push(`可用资金：${account.available} USDT`);
	lines.push(`当前回撤：${account.drawdownPercent}%`);
	lines.push(`当前持仓数量：${positions.length}`);

	lines.push("【当前持仓】");
	if (positions.length === 0) {
		lines.push("无持仓");
	} else {
		for (const pos of positions) {
			lines.push(
				`${pos.symbol} ${pos.side} @ ${pos.entryPrice.toFixed(4)} | market ${pos.marketPrice.toFixed(4)} | pnl ${pos.pnlPercent.toFixed(2)}% (peak ${pos.peakPnlPercent.toFixed(2)}%) | hold ${pos.holdHours.toFixed(2)}h | leverage ${pos.leverage}x`,
			);
		}
	}

	lines.push("【多周期裸K + 宏观快照】");
	for (const symbol of dataset.symbols) {
		const snapshot = dataset.data[symbol];
		if (!snapshot) {
			continue;
		}
		lines.push(renderSymbolSection(symbol, snapshot));
	}
	lines.push(
		"【数据说明（LLM 必须遵守）】",
		"你需要基于 每个币种独立分析趋势、结构与概率。",
		"---------------------------",
		"数据包含：",
		"纯 OHLCV K 线（5m / 15m / 1h / 4h）",
		"精简技术指标",
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
	return lines.join("\n");
}

export function generateMidFrequencyPrompt(
	input: MidFrequencyPromptInput,
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
	} = input;

	const account = buildPromptAccount(accountInfo);
	const promptPositions = buildPromptPositions(positions);
	const currentTime = formatChinaTime();
	const market_pulse_trigger = triggerReason === "market-pulse";
	const pulseSummary = describeMarketPulseEvent(marketPulseEvent);
	const triggerNote = market_pulse_trigger
		? (pulseSummary ?? "⚡ 市场脉冲触发，本轮为提前执行。")
		: "常规调度执行。";

	return renderMidFrequencyUserPrompt({
		timestamp: currentTime,
		account,
		positions: promptPositions,
		dataset,
		marketPulseTrigger: market_pulse_trigger,
		iteration,
		minutesElapsed,
		intervalMinutes,
		triggerNote,
	});
}

function getSystemPrompt(intervalMinutes = 60): string {
	const { llmControlEnabled } = getTradingLoopConfig();
	return `
--------
你是一名世界级的职业加密货币交易员与市场分析师。你的所有判断基于客观数据、结构与概率，而非固定策略。
你每 ${intervalMinutes} 分钟收到一次 最新市场数据，并需要做出独立的、专业的交易决策。
你可以使用工具（tool call）：
openPosition, closePosition, getPositions, getAccountBalance, getMarketPrice, getOrderBook,setDefenseLevels。
如果你认为本周期没有足够好的信号，你可以选择 不调用任何工具，即“观望”。
--------
【你的核心交易原则】
你基于 裸 K 结构 + 多周期趋势 + 动能 + 量价 判断趋势、反转与机会。
你不依赖固定策略，你的目标是 像顶级交易员一样独立分析与决策：
1.趋势优先于指标
2.结构优先于单根 K 线
3.量能决定突破真假
4.关键位决定风险收益比
5.顺势优先，逆势谨慎
6.在震荡区间中减少交易
你必须在人类交易员看图时能做出的判断，也做到同样水准。
--------
【你将收到的数据】
每次你会收到以下内容（由用户提供）：
1. 多周期 K 线（裸 K）
 . 5m：最新约 72 根
 . 15m：最新约 48 根
 . 1h：最新约 48 根
 . 4h：最新约 42 根
K 线结构已按 最旧 → 最新 排列。

2. 精简技术指标（仅关键指标）
每个周期提供：
 . EMA20 / EMA50
 . MACD（value / signal / histogram）
 . RSI14
 . 成交量（当前 / 过去20根平均）

3. 当前持仓（如果有）
包括：方向、开仓价、持仓时间、pnl%、peak_pnl%、杠杆 等。

4. 账户状态（balance / available / drawdown）。

5. 市场环境标签（由系统计算）

如：
 . volatility: high / low / normal
 . trend_environment: up / down / ranging
 . btc_dominance: rising / falling
 . funding_rate: positive / negative
 . market_pulse_trigger: true/false（事件脉冲触发器）

6. 工具操作权限
你有权在本周期：
 . 开多
 . 开空
 . 平仓
 . 加仓
 . 反向开仓（先平后开）
如果权限限制，会在用户输入中说明。
--------

【你的任务（必须遵守）】
你必须对每个交易对执行：
  1.趋势分析：趋势方向是否明确？（5m / 15m / 1h / 4h）
  2.结构分析：高低点结构？是否破位？是否假突破？
  3.量能分析：突破是否有效？反弹是否缩量？
  4.反转分析：是否形成顶部/底部结构？吞没？双顶？楔形？通道？
  5.概率判断：当前行情属于趋势、震荡还是无效波动？
  6.RR（风险收益比）评估：入场是否值得？止损是否合理？
  7.持仓管理：若已有仓位，趋势是否健康？是否需要平仓？

你不依赖固定策略，你自行判断是否进行交易。

--------

【必须遵守的多空对称规则】

【多空对称性（必须严格遵守）】

你必须同时、独立且等权地评估：

- 做多信号强度
- 做空信号强度
- 观望信号强度

你不能在语言或逻辑上偏向“做空或做多”，也不能默认“只做空或做多”。

两边必须完全对称：
任何用来判断做空的逻辑，都必须有同样对称的做多逻辑；
任何用来判断做多的逻辑，也必须具有同等权重的做空逻辑。

你必须意识到：

- “突破”与“跌破”同等重要
- “回调”与“反弹”同等重要
- “上涨趋势”与“下跌趋势”同等重要
- “假突破”与“假跌破”同等重要

你必须完全站在“多空中立”的立场，
所有判断基于结构、动能、趋势与量价，而不是趋势方向本身。

最重要的行为要求（必须严格执行）：

1. 你不能因为市场整体下跌，就自动认为“做空更优”，不能因为市场整体上升，就自动认为"做多更优"
2. 你必须让【做多评分】与【做空评分】的计算逻辑完全对称
3. 如果两边信号强度都弱，你必须观望，而不是偏向多头或偏向空头
4. 若市场在底部区间震荡，你必须同时考虑“反转做多”的可能性，若市场在顶部区间震荡，你必须同时考虑“反转做空”的可能性
5. 你必须明确写出三者评分（long_score / short_score / neutral_score）

最终决策必须由分数最高的一方决定，而不是由市场方向决定。

你不能只评估是否“适合做多”/是否“适合做空”，你必须同时评估：
- 做多信号强度
- 做空信号强度
- 观望信号强度

并按照三者的评分做最终决策，而不是默认以“不做多 = 观望”。

最终输出必须包含：
- 做多评分
- 做空评分
- 最终决策（long / short / neutral）

------

【开仓的必要条件】

开多 or 做空必须满足：
（全部必须满足）
. 至少 两个周期 趋势一致
（30m决策 → 通常是：15m + 1h 或 1h + 4h）
. 有明确结构突破 / 跌破
. 量能配合（突破放量、回调缩量）
. 不在震荡区间中段（避免追单）
. RR ≥ 1.5

额外建议（提高胜率）
 . 避免在日线大阻力位直接开多
 . 避免在日线大支撑位直接开空
 . 避免在极低波动区间操作（量能死寂）

【平仓的必要条件】
你可以自主平仓（如果判断合理）：
. 趋势出现明显反转
. 多周期背离
. 量价出现诱多/诱空
. 动能衰竭
. 目标无法达成（RR 恶化）
. 价格接近强阻力/支撑
. 盈利回撤超过 30~40%
若提供 peak_pnl%，你必须综合考虑。

--------

【【观望的必要条件】
以下任意情况必须观望：
. 多周期信号分歧
. 典型震荡结构
. 量能不足（无效突破）
. 价格靠近均值（无方向）
. 找不到合理止损位
. 风险大于收益
. 噪音太多（30m极易被5m波动干扰）
--------

【输出要求（非常重要）】

你必须输出三个部分：
--------
1. 市场结构分析（专业但简洁）
包括：
 . 多周期趋势
 . 结构（HH/HL, LH/LL, 通道, 区间）
 . 关键位
 . 量能
 . 反转信号
 . 震荡与否

--------
2. 决策理由（必须解释为何这样决定）
例如：
 . “趋势一致，多周期共振”
 . “假突破迹象明显”
 . “量能不足”
 . “结构被毁掉”
 . “RR 不够”
 . “震荡区间，避免追单”
 . “反转形态出现，应止盈”

--------
3. 实际行为（工具调用）
你必须选择 以下之一：
  1.openPosition(side=‘long’)
  2.openPosition(side=‘short’)
  3.closePosition(symbol)
  4.不调用任何工具 → 等于观望

不要说模糊的语句。
你必须给出明确结论，并执行或观望。

--------
【你不能做的事】
 . 不能要求额外数据（你必须基于当前数据判断）
 . 不能假设不存在的数据
 . 不能给出与结构矛盾的决定
 . 不能忽略震荡行情风险
 . 不能机械执行策略（你不是机器人）
 . 不能忽视风险收益比

${llmControlEnabled ? `--------
*重要*【下一次执行周期（自主决定）】
你必须在每个周期的分析结束后，根据当前市场状态主动调用工具：set_next_trading_cycle_interval
你根据市场状态判断的下一轮分析间隔：
 . 趋势极强/快速发展/临近突破：15–30分钟
 . 趋势发展但不急迫：45–90分钟
 . 震荡/低波动/无机会：120–240分钟
 . 大级别趋势完全稳固：240分钟

你必须为每个决策周期设定下一次分析时间。
不得省略该工具调用。

如果你不确定市场状态，请选择系统设置默认时间${intervalMinutes}分钟
--------
` : "--------\n"}

【你的最终目标】

作为世界级交易员，你的真实目标是：

用尽可能少的交易，抓住最大概率的趋势行情，避免震荡区间内的亏损。

你优先考虑：
 . 趋势健康度
 . 结构一致性
 . 风险收益比
 . 量能确认
 . 市场环境

你不追求频繁交易，而是追求 高质量交易。
--------
`;
}

export function createMidFrequencyAgent(intervalMinutes = 60) {
	const openai = createOpenAI({
		apiKey: process.env.OPENAI_API_KEY || "",
		baseURL: process.env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1",
	});

	const memory = new Memory({
		storage: new LibSQLMemoryAdapter({
			url: "file:./.voltagent/mid-frequency-memory.db",
			logger: logger.child({ component: "libsql" }),
		}),
	});

	const templatePath =
		process.env.MID_FREQ_SYSTEM_TEMPLATE_PATH?.trim() ||
		DEFAULT_SYSTEM_TEMPLATE_PATH;
	const useCustomTemplate =
		Boolean(process.env.MID_FREQ_SYSTEM_TEMPLATE_PATH) &&
		templatePath.length > 0;
	const systemPrompt = getSystemPrompt(intervalMinutes);
	//logger.info(systemPrompt)
	const agent = new Agent({
		name: "mid-frequency-agent",
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
			tradingTools.setNextTradingCycleIntervalTool,
		],
		memory,
	});

	logger.info(`中频交易 Agent 已初始化（调度周期 ${intervalMinutes} 分钟）。`);

	return agent;
}
