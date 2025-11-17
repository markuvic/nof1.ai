import { createPinoLogger } from "@voltagent/logger";
import type { LevelWithSilent } from "pino";
import { createExchangeClient } from "../exchanges";
import type { PromptCandle, MarketEnvironmentSnapshot } from "../lowFrequencyAgent/dataCollector";

export type MidFrequencyTimeframe = "5m" | "15m" | "1h" | "4h";

const TIMEFRAME_CONFIG: Record<
	MidFrequencyTimeframe,
	{ interval: string; limit: number }
> = {
	"5m": { interval: "5m", limit: 72 },
	"15m": { interval: "15m", limit: 48 },
	"1h": { interval: "1h", limit: 48 },
	"4h": { interval: "4h", limit: 42 },
};

export interface VolumeSnapshot {
	volume_now_5m: number;
	volume_avg_5m: number;
	volume_now_15m: number;
	volume_avg_15m: number;
}

export interface AtrSnapshot {
	atr_5m: number;
	atr_15m: number;
	atr_1h: number;
}

export interface RsiSnapshot {
	rsi_7_15m: number;
	rsi_14_1h: number;
	rsi_14_4h: number;
}

export interface MacdSnapshot {
	macd_1h: number;
	signal_1h: number;
	hist_1h: number;
}

export interface TrendSummarySnapshot {
	"5m": "up" | "down" | "ranging";
	"15m": "up" | "down" | "ranging";
	"1h": "up" | "down" | "ranging";
	"4h": "up" | "down" | "ranging";
}

export interface FundingRateSnapshot {
	now: number;
	avg8h: number;
}

export interface OrderBookStrength {
	bid_strength: number;
	ask_strength: number;
}

export interface MidFrequencySymbolSnapshot {
	candles: Record<MidFrequencyTimeframe, PromptCandle[]>;
	currentPrice: number;
	volumeSnapshot: VolumeSnapshot;
	atr: AtrSnapshot;
	rsi: RsiSnapshot;
	macd: MacdSnapshot;
	trendSummary: TrendSummarySnapshot;
	fundingRate: FundingRateSnapshot;
	orderbook: OrderBookStrength;
}

export interface MidFrequencyMarketDataset {
	symbols: string[];
	data: Record<string, MidFrequencySymbolSnapshot>;
	marketEnvironment: MarketEnvironmentSnapshot;
}

const logger = createPinoLogger({
	name: "mid-frequency-data",
	level: (process.env.LOG_LEVEL || "info") as LevelWithSilent,
});

export async function collectMidFrequencyMarketDataset(
	symbols: string[],
): Promise<MidFrequencyMarketDataset> {
	const exchangeClient = createExchangeClient();
	const dataset: MidFrequencyMarketDataset = {
		symbols: [],
		data: {},
		marketEnvironment: {
			volatility: "normal",
			trendEnvironment: "ranging",
			btcDominance: "stable",
			fundingBias: "neutral",
		},
	};

	for (const symbol of symbols) {
		const contract = `${symbol}_USDT`;
		dataset.symbols.push(symbol);

		const candles: Record<MidFrequencyTimeframe, PromptCandle[]> =
			Object.fromEntries(
				Object.keys(TIMEFRAME_CONFIG).map((tf) => [
					tf,
					[],
				]),
			) as Record<MidFrequencyTimeframe, PromptCandle[]>;

		for (const [tf, cfg] of Object.entries(TIMEFRAME_CONFIG) as Array<
			[MidFrequencyTimeframe, { interval: string; limit: number }]
		>) {
			try {
				const raw = await exchangeClient.getFuturesCandles(
					contract,
					cfg.interval,
					cfg.limit,
				);
				candles[tf] = normalizeCandles(raw);
			} catch (error) {
				logger.warn(
					`获取 ${symbol} ${cfg.interval} K线失败: ${
						(error as Error).message
					}`,
				);
				candles[tf] = [];
			}
		}

		let currentPrice = 0;
		try {
			const ticker = await exchangeClient.getFuturesTicker(contract);
			currentPrice = extractTickerPrice(ticker);
		} catch (error) {
			logger.warn(`获取 ${symbol} 最新价失败: ${(error as Error).message}`);
		}

		const volumeSnapshot = buildVolumeSnapshot(candles);
		const atr = buildAtrSnapshot(candles);
		const rsi = buildRsiSnapshot(candles);
		const macd = buildMacdSnapshot(candles);
		const trendSummary = buildTrendSummary(candles);
		const fundingRate = await buildFundingRateSnapshot(exchangeClient, contract);
		const orderbook = await buildOrderBookStrength(exchangeClient, contract);

		dataset.data[symbol] = {
			candles,
			currentPrice,
			volumeSnapshot,
			atr,
			rsi,
			macd,
			trendSummary,
			fundingRate,
			orderbook,
		};
	}

	return dataset;
}

function normalizeCandles(raw: unknown): PromptCandle[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw
		.map((item) => {
			const tuple = Array.isArray(item) ? item : [];
			const openTime = Number(item?.t ?? item?.time ?? tuple[0]);
			const open = Number(item?.o ?? item?.open ?? tuple[1]);
			const high = Number(item?.h ?? item?.high ?? tuple[2]);
			const low = Number(item?.l ?? item?.low ?? tuple[3]);
			const close = Number(item?.c ?? item?.close ?? tuple[4]);
			const volume = Number(item?.v ?? item?.volume ?? tuple[5]);

			if (
				!Number.isFinite(openTime) ||
				!Number.isFinite(open) ||
				!Number.isFinite(high) ||
				!Number.isFinite(low) ||
				!Number.isFinite(close)
			) {
				return null;
			}
			return {
				timestamp: normalizeTimestamp(openTime),
				open,
				high,
				low,
				close,
				volume: Number.isFinite(volume) ? volume : 0,
			};
		})
		.filter((candle): candle is PromptCandle => candle !== null)
		.sort((a, b) => a.timestamp - b.timestamp);
}

function normalizeTimestamp(value: number): number {
	if (value > 1_000_000_000_000) {
		return value;
	}
	return value * 1000;
}

function buildVolumeSnapshot(
	candles: Record<MidFrequencyTimeframe, PromptCandle[]>,
): VolumeSnapshot {
	const volume_now_5m = candles["5m"].at(-1)?.volume ?? 0;
	const volume_avg_5m = calculateAverage(
		candles["5m"].slice(0, -1).map((c) => c.volume),
	);
	const volume_now_15m = candles["15m"].at(-1)?.volume ?? 0;
	const volume_avg_15m = calculateAverage(
		candles["15m"].slice(0, -1).map((c) => c.volume),
	);
	return {
		volume_now_5m,
		volume_avg_5m,
		volume_now_15m,
		volume_avg_15m,
	};
}

function buildAtrSnapshot(
	candles: Record<MidFrequencyTimeframe, PromptCandle[]>,
): AtrSnapshot {
	return {
		atr_5m: calculateATR(candles["5m"], 14),
		atr_15m: calculateATR(candles["15m"], 14),
		atr_1h: calculateATR(candles["1h"], 14),
	};
}

function buildRsiSnapshot(
	candles: Record<MidFrequencyTimeframe, PromptCandle[]>,
): RsiSnapshot {
	return {
		rsi_7_15m: calculateRSI(candles["15m"].map((c) => c.close), 7),
		rsi_14_1h: calculateRSI(candles["1h"].map((c) => c.close), 14),
		rsi_14_4h: calculateRSI(candles["4h"].map((c) => c.close), 14),
	};
}

function buildMacdSnapshot(
	candles: Record<MidFrequencyTimeframe, PromptCandle[]>,
): MacdSnapshot {
	const macd = calculateMACD(candles["1h"].map((c) => c.close));
	return {
		macd_1h: macd.value,
		signal_1h: macd.signal,
		hist_1h: macd.histogram,
	};
}

function buildTrendSummary(
	candles: Record<MidFrequencyTimeframe, PromptCandle[]>,
): TrendSummarySnapshot {
	return {
		"5m": determineTrend(candles["5m"]),
		"15m": determineTrend(candles["15m"]),
		"1h": determineTrend(candles["1h"]),
		"4h": determineTrend(candles["4h"]),
	};
}

async function buildFundingRateSnapshot(
	exchangeClient: ReturnType<typeof createExchangeClient>,
	contract: string,
): Promise<FundingRateSnapshot> {
	try {
		if (typeof exchangeClient.getFundingRateHistory === "function") {
			const history = await exchangeClient.getFundingRateHistory(contract, 3);
			const rates = history
				.map((item: any) => Number.parseFloat(item?.fundingRate ?? item?.rate ?? "0"))
				.filter((value) => Number.isFinite(value));
			const now = rates.at(-1) ?? 0;
			const avg8h = rates.length > 0 ? calculateAverage(rates) : now;
			return { now, avg8h };
		}
		const latest = await exchangeClient.getFundingRate(contract);
		const value = Number.parseFloat(latest?.fundingRate ?? latest?.rate ?? "0");
		return { now: Number.isFinite(value) ? value : 0, avg8h: Number.isFinite(value) ? value : 0 };
	} catch (error) {
		logger.warn(`获取 ${contract} 资金费率失败: ${(error as Error).message}`);
		return { now: 0, avg8h: 0 };
	}
}

function normalizeOrderbookSide(
	entries: unknown,
): Array<{ price: number; size: number }> {
	if (!Array.isArray(entries)) {
		return [];
	}
	const normalized: Array<{ price: number; size: number }> = [];
	for (const entry of entries) {
		if (Array.isArray(entry) && entry.length >= 2) {
			const price = Number.parseFloat(entry[0]);
			const size = Number.parseFloat(entry[1]);
			if (Number.isFinite(price) && Number.isFinite(size)) {
				normalized.push({ price, size });
			}
			continue;
		}
		if (entry && typeof entry === "object") {
			const candidate = entry as Record<string, unknown>;
			const rawPrice =
				candidate.price ??
				candidate.p ??
				(candidate as Record<string, unknown>)[0];
			const rawSize =
				candidate.size ??
				candidate.amount ??
				candidate.qty ??
				(candidate as Record<string, unknown>)[1];
			const price = Number.parseFloat(
				typeof rawPrice === "number" ? rawPrice.toString() : String(rawPrice ?? ""),
			);
			const size = Number.parseFloat(
				typeof rawSize === "number" ? rawSize.toString() : String(rawSize ?? ""),
			);
			if (Number.isFinite(price) && Number.isFinite(size)) {
				normalized.push({ price, size });
			}
		}
	}
	return normalized;
}

async function buildOrderBookStrength(
	exchangeClient: ReturnType<typeof createExchangeClient>,
	contract: string,
): Promise<OrderBookStrength> {
	try {
		const orderbook = await exchangeClient.getOrderBook(contract, 20);
		const bids = normalizeOrderbookSide(orderbook?.bids);
		const asks = normalizeOrderbookSide(orderbook?.asks);
		const bidNotional = bids.reduce(
			(sum, entry) => sum + entry.price * entry.size,
			0,
		);
		const askNotional = asks.reduce(
			(sum, entry) => sum + entry.price * entry.size,
			0,
		);
		const total = bidNotional + askNotional;
		if (total <= 0) {
			return { bid_strength: 0.5, ask_strength: 0.5 };
		}
		const bid_strength = bidNotional / total;
		const ask_strength = askNotional / total;
		return {
			bid_strength: Number.isFinite(bid_strength) ? bid_strength : 0.5,
			ask_strength: Number.isFinite(ask_strength) ? ask_strength : 0.5,
		};
	} catch (error) {
		logger.warn(`获取 ${contract} 订单簿失败: ${(error as Error).message}`);
		return { bid_strength: 0.5, ask_strength: 0.5 };
	}
}

function extractTickerPrice(raw: any): number {
	const candidates = [
		raw?.last,
		raw?.last_price,
		raw?.mark_price,
		raw?.markPrice,
		raw?.price,
		raw?.index_price,
	];
	for (const candidate of candidates) {
		const parsed =
			typeof candidate === "number"
				? candidate
				: Number.parseFloat(candidate ?? "0");
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return 0;
}

function calculateAverage(values: number[]): number {
	if (!values.length) {
		return 0;
	}
	const sum = values.reduce((acc, value) => acc + value, 0);
	return sum / values.length;
}

function calculateATR(candles: PromptCandle[], period: number): number {
	if (candles.length < period + 1) {
		return 0;
	}
	const trs: number[] = [];
	for (let i = 1; i < candles.length; i++) {
		const current = candles[i];
		const prev = candles[i - 1];
		const highLow = current.high - current.low;
		const highClose = Math.abs(current.high - prev.close);
		const lowClose = Math.abs(current.low - prev.close);
		const tr = Math.max(highLow, highClose, lowClose);
		trs.push(tr);
	}
	const atrValues: number[] = [];
	let atr = trs.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
	atrValues.push(atr);
	for (let i = period; i < trs.length; i++) {
		atr = (atr * (period - 1) + trs[i]) / period;
		atrValues.push(atr);
	}
	return atrValues.at(-1) ?? 0;
}

function calculateRSI(values: number[], period: number): number {
	if (values.length < period + 1) {
		return 50;
	}
	let gains = 0;
	let losses = 0;
	for (let i = 1; i <= period; i++) {
		const delta = values[i] - values[i - 1];
		if (delta >= 0) {
			gains += delta;
		} else {
			losses -= delta;
		}
	}
	let avgGain = gains / period;
	let avgLoss = losses / period;
	for (let i = period + 1; i < values.length; i++) {
		const delta = values[i] - values[i - 1];
		if (delta >= 0) {
			avgGain = (avgGain * (period - 1) + delta) / period;
			avgLoss = (avgLoss * (period - 1)) / period;
		} else {
			avgGain = (avgGain * (period - 1)) / period;
			avgLoss = (avgLoss * (period - 1) - delta) / period;
		}
	}
	if (avgLoss === 0) {
		return 100;
	}
	const rs = avgGain / avgLoss;
	const rsi = 100 - 100 / (1 + rs);
	return Number.isFinite(rsi) ? Math.min(Math.max(rsi, 0), 100) : 50;
}

function calculateMACD(values: number[]) {
	if (values.length < 35) {
		return { value: 0, signal: 0, histogram: 0 };
	}
	const ema12 = calculateEMAForSeries(values, 12);
	const ema26 = calculateEMAForSeries(values, 26);
	const macdLine = ema12.map((value, idx) => value - (ema26[idx] ?? value));
	const signal = calculateEMAForSeries(macdLine, 9);
	const macdValue = macdLine.at(-1) ?? 0;
	const signalValue = signal.at(-1) ?? 0;
	const histogram = macdValue - signalValue;
	return {
		value: Number.isFinite(macdValue) ? macdValue : 0,
		signal: Number.isFinite(signalValue) ? signalValue : 0,
		histogram: Number.isFinite(histogram) ? histogram : 0,
	};
}

function calculateEMAForSeries(values: number[], period: number): number[] {
	const ema: number[] = [];
	const k = 2 / (period + 1);
	let prev = values[0] ?? 0;
	for (let i = 0; i < values.length; i++) {
		const value = values[i] ?? prev;
		prev = i === 0 ? value : value * k + prev * (1 - k);
		ema.push(prev);
	}
	return ema;
}

function determineTrend(candles: PromptCandle[]): TrendSummarySnapshot["5m"] {
	if (candles.length < 5) {
		return "ranging";
	}
	const start = candles.at(-20)?.close ?? candles[0].close;
	const end = candles.at(-1)?.close ?? start;
	if (!Number.isFinite(start) || !Number.isFinite(end) || start === 0) {
		return "ranging";
	}
	const changePercent = ((end - start) / start) * 100;
	if (changePercent >= 0.5) {
		return "up";
	}
	if (changePercent <= -0.5) {
		return "down";
	}
	return "ranging";
}
