import { createPinoLogger } from "@voltagent/logger";
import type { LevelWithSilent } from "pino";
import { createExchangeClient } from "../exchanges";

export type LowFrequencyTimeframe = "15m" | "1h" | "4h" | "1d";

const TIMEFRAME_CONFIG: Record<
	LowFrequencyTimeframe,
	{ interval: string; limit: number }
> = {
	"15m": { interval: "15m", limit: 48 },
	"1h": { interval: "1h", limit: 72 },
	"4h": { interval: "4h", limit: 90 },
	"1d": { interval: "1d", limit: 60 },
};

export interface PromptCandle {
	timestamp: number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
}

export interface TimeframeIndicators {
	ema20: number;
	ema50: number;
	macd: {
		value: number;
		signal: number;
		histogram: number;
	};
	rsi14: number;
	volume: {
		current: number;
		avg20: number;
	};
}

export interface MarketEnvironmentSnapshot {
	volatility: "high" | "normal" | "low";
	trendEnvironment: "up" | "down" | "ranging";
	btcDominance: "rising" | "falling" | "stable";
	fundingBias: "positive" | "negative" | "neutral";
}

export interface LowFrequencyMarketDataset {
	symbols: string[];
	k: Record<string, Record<LowFrequencyTimeframe, PromptCandle[]>>;
	indicators: Record<
		string,
		Record<LowFrequencyTimeframe, TimeframeIndicators>
	>;
	fundingRates: Record<string, number>;
	marketEnvironment: MarketEnvironmentSnapshot;
}

const logger = createPinoLogger({
	name: "low-frequency-data",
	level: (process.env.LOG_LEVEL || "info") as LevelWithSilent,
});

export async function collectLowFrequencyMarketDataset(
	symbols: string[],
): Promise<LowFrequencyMarketDataset> {
	const exchangeClient = createExchangeClient();
	const dataset: LowFrequencyMarketDataset = {
		symbols: [],
		k: {},
		indicators: {},
		fundingRates: {},
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
		dataset.k[symbol] = Object.fromEntries(
			Object.keys(TIMEFRAME_CONFIG).map((tf) => [
				tf as LowFrequencyTimeframe,
				[],
			]),
		) as Record<LowFrequencyTimeframe, PromptCandle[]>;
		dataset.indicators[symbol] = Object.fromEntries(
			Object.keys(TIMEFRAME_CONFIG).map((tf) => [
				tf as LowFrequencyTimeframe,
				createEmptyIndicators(),
			]),
		) as Record<LowFrequencyTimeframe, TimeframeIndicators>;

		const timeframeEntries = await Promise.all(
			(
				Object.entries(TIMEFRAME_CONFIG) as Array<
					[LowFrequencyTimeframe, { interval: string; limit: number }]
				>
			).map(async ([tfKey, cfg]) => {
				try {
					const raw = await exchangeClient.getFuturesCandles(
						contract,
						cfg.interval,
						cfg.limit,
					);
					const candles = normalizeCandles(raw);
					return [tfKey, candles] as const;
				} catch (error) {
					logger.warn(
						`获取 ${symbol} ${cfg.interval} K线失败: ${(error as Error).message}`,
					);
					return [tfKey, []] as const;
				}
			}),
		);

		for (const [tfKey, candles] of timeframeEntries) {
			dataset.k[symbol][tfKey] = candles;
			dataset.indicators[symbol][tfKey] = calculateIndicators(candles);
		}

		try {
			const fundingRateRaw = await exchangeClient.getFundingRate(contract);
			const fundingRate = extractFundingRate(fundingRateRaw);
			dataset.fundingRates[symbol] = fundingRate;
		} catch (error) {
			logger.warn(`获取 ${symbol} 资金费率失败: ${(error as Error).message}`);
			dataset.fundingRates[symbol] = 0;
		}
	}

	dataset.marketEnvironment = deriveMarketEnvironment(dataset);

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

function createEmptyIndicators(): TimeframeIndicators {
	return {
		ema20: 0,
		ema50: 0,
		macd: { value: 0, signal: 0, histogram: 0 },
		rsi14: 50,
		volume: { current: 0, avg20: 0 },
	};
}

function calculateIndicators(candles: PromptCandle[]): TimeframeIndicators {
	if (!candles.length) {
		return createEmptyIndicators();
	}
	const closes = candles.map((c) => c.close);
	const volumes = candles.map((c) => c.volume);

	const ema20 = calculateEMA(closes, 20);
	const ema50 = calculateEMA(closes, 50);
	const macd = calculateMACD(closes);
	const rsi14 = calculateRSI(closes, 14);
	const volumeCurrent = volumes.at(-1) ?? 0;
	const avgVolume = calculateAverage(volumes.slice(-20));

	return {
		ema20,
		ema50,
		macd,
		rsi14,
		volume: {
			current: volumeCurrent,
			avg20: avgVolume,
		},
	};
}

function calculateEMA(values: number[], period: number): number {
	if (values.length === 0 || period <= 0) {
		return 0;
	}
	const k = 2 / (period + 1);
	let ema =
		values.length >= period
			? values.slice(0, period).reduce((sum, value) => sum + value, 0) / period
			: values[0];
	for (let i = period; i < values.length; i++) {
		const value = values[i];
		ema = value * k + ema * (1 - k);
	}
	return Number.isFinite(ema) ? ema : 0;
}

function calculateMACD(values: number[]) {
	if (values.length < 35) {
		return { value: 0, signal: 0, histogram: 0 };
	}
	const ema12Series = calculateEMAForSeries(values, 12);
	const ema26Series = calculateEMAForSeries(values, 26);
	const macdLine = ema12Series.map((value, idx) => {
		const slow = ema26Series[idx] ?? ema26Series[ema26Series.length - 1] ?? 0;
		return value - slow;
	});
	const signalSeries = calculateEMAForSeries(macdLine, 9);
	const macdValue = macdLine.at(-1) ?? 0;
	const signalValue = signalSeries.at(-1) ?? 0;
	const histogram = macdValue - signalValue;
	return {
		value: Number.isFinite(macdValue) ? macdValue : 0,
		signal: Number.isFinite(signalValue) ? signalValue : 0,
		histogram: Number.isFinite(histogram) ? histogram : 0,
	};
}

function calculateEMAForSeries(values: number[], period: number): number[] {
	if (!values.length) {
		return [];
	}
	const k = 2 / (period + 1);
	const ema: number[] = [];
	let prev = values[0];
	for (let i = 0; i < values.length; i++) {
		const value = values[i];
		prev = i === 0 ? value : value * k + prev * (1 - k);
		ema.push(prev);
	}
	return ema;
}

function calculateRSI(values: number[], period: number): number {
	if (values.length < period + 1) {
		return 50;
	}
	let gains = 0;
	let losses = 0;
	for (let i = 1; i <= period; i++) {
		const current = values[i] ?? values[i - 1] ?? values[0] ?? 0;
		const previous = values[i - 1] ?? current;
		const delta = current - previous;
		if (delta >= 0) {
			gains += delta;
		} else {
			losses -= delta;
		}
	}
	let avgGain = gains / period;
	let avgLoss = losses / period;
	for (let i = period + 1; i < values.length; i++) {
		const current = values[i] ?? values[i - 1] ?? values[i - 2] ?? 0;
		const previous = values[i - 1] ?? current;
		const delta = current - previous;
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

function calculateAverage(values: number[]): number {
	if (!values.length) {
		return 0;
	}
	const total = values.reduce((sum, value) => sum + value, 0);
	return total / values.length;
}

function extractFundingRate(raw: unknown): number {
	if (!raw) {
		return 0;
	}
	const source = raw as Record<string, unknown>;
	const candidates = [
		source?.fundingRate,
		source?.rate,
		source?.value,
		source?.r,
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

function deriveMarketEnvironment(
	dataset: Omit<LowFrequencyMarketDataset, "marketEnvironment">,
): MarketEnvironmentSnapshot {
	const volatilitySamples: number[] = [];
	const trendSamples: number[] = [];
	const dailyReturns: Record<string, number> = {};

	for (const symbol of dataset.symbols) {
		const k15 = dataset.k[symbol]?.["15m"] ?? [];
		const volatilityCandidate =
			k15.length > 1 ? averageAbsoluteReturn(k15) * 100 : undefined;
		if (
			typeof volatilityCandidate === "number" &&
			Number.isFinite(volatilityCandidate)
		) {
			volatilitySamples.push(volatilityCandidate);
		}

		const k4h = dataset.k[symbol]?.["4h"] ?? [];
		const trendCandidate = percentChangeFromWindow(k4h, 20);
		if (typeof trendCandidate === "number" && Number.isFinite(trendCandidate)) {
			trendSamples.push(trendCandidate);
		}

		const k1d = dataset.k[symbol]?.["1d"] ?? [];
		const dailyReturnCandidate = percentChangeFromWindow(k1d, 5);
		if (
			typeof dailyReturnCandidate === "number" &&
			Number.isFinite(dailyReturnCandidate)
		) {
			dailyReturns[symbol] = dailyReturnCandidate;
		}
	}

	const avgVolatility = calculateAverage(volatilitySamples);
	const volatilityLabel =
		avgVolatility >= 1.2 ? "high" : avgVolatility <= 0.4 ? "low" : "normal";

	const avgTrend = calculateAverage(trendSamples);
	const trendEnvironment =
		avgTrend >= 1 ? "up" : avgTrend <= -1 ? "down" : "ranging";

	const btcReturn = dailyReturns.BTC;
	const altSymbols = Object.keys(dailyReturns).filter(
		(symbol) => symbol !== "BTC",
	);
	const altReturnValues = altSymbols
		.map((symbol) => dailyReturns[symbol])
		.filter(
			(value): value is number =>
				typeof value === "number" && Number.isFinite(value),
		);
	const altAvg = calculateAverage(altReturnValues);
	let btcDominance: MarketEnvironmentSnapshot["btcDominance"] = "stable";
	if (
		typeof btcReturn === "number" &&
		Number.isFinite(btcReturn) &&
		altReturnValues.length > 0
	) {
		const diff = btcReturn - altAvg;
		if (diff >= 0.5) {
			btcDominance = "rising";
		} else if (diff <= -0.5) {
			btcDominance = "falling";
		} else {
			btcDominance = "stable";
		}
	}

	const fundingRates = Object.values(dataset.fundingRates ?? {});
	const avgFunding = calculateAverage(
		fundingRates.filter((rate) => Number.isFinite(rate)),
	);
	const fundingBias =
		avgFunding >= 0.0005
			? "positive"
			: avgFunding <= -0.0005
				? "negative"
				: "neutral";

	return {
		volatility: volatilityLabel,
		trendEnvironment,
		btcDominance,
		fundingBias,
	};
}

function averageAbsoluteReturn(candles: PromptCandle[]): number {
	let sum = 0;
	let count = 0;
	for (let i = 1; i < candles.length; i++) {
		const prevClose = candles[i - 1]?.close;
		const currentClose = candles[i]?.close;
		if (
			typeof prevClose === "number" &&
			prevClose > 0 &&
			typeof currentClose === "number"
		) {
			sum += Math.abs((currentClose - prevClose) / prevClose);
			count++;
		}
	}
	return count > 0 ? sum / count : 0;
}

function percentChangeFromWindow(
	candles: PromptCandle[],
	window: number,
): number | undefined {
	if (candles.length <= window) {
		return undefined;
	}
	const latestCandle = candles.at(-1);
	const baseCandle = candles.at(-window);
	if (!latestCandle || !baseCandle) {
		return undefined;
	}
	const latest = latestCandle.close;
	const base = baseCandle.close;
	if (!Number.isFinite(latest) || !Number.isFinite(base) || base === 0) {
		return undefined;
	}
	return ((latest - base) / base) * 100;
}
