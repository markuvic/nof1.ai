import { createPinoLogger } from "@voltagent/logger";
import { createExchangeClient } from "./exchanges";
import { collectNakedKData, type NakedKDataset } from "./marketData/nakedKCollector";

const logger = createPinoLogger({
  name: "hybrid-context",
  level: (process.env.LOG_LEVEL || "info") as any,
});

interface NormalizedCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface TrendSnapshot {
  value: number;
  previous: number;
  direction: "up" | "down" | "flat";
  delta: number;
}

interface EMASnapshot extends TrendSnapshot {
  label: string;
}

interface ATRSnapshot extends TrendSnapshot {
  percent: number;
}

interface MacdSnapshot {
  macd: number;
  signal: number;
  histogram: number;
  momentum: "expanding" | "contracting" | "neutral";
}

interface RsiSnapshot extends TrendSnapshot {
  changeOver5: number;
  label: string;
}

interface BollingerSnapshot {
  upper: number;
  lower: number;
  bandwidthPercent: number;
}

interface OrderBookPressure {
  bidVolume: number;
  askVolume: number;
  delta: number;
  ratio: number;
}

interface MultiTimeframeRow {
  interval: string;
  currentPrice: number;
  ema20: number;
  ema50: number;
  macd: number;
  rsi14: number;
  volume: number;
  avgVolume: number;
}

export interface HybridSymbolSnapshot {
  symbol: string;
  price: number;
  change24h: number;
  fundingRate: number;
  fundingDirection: "positive" | "negative" | "neutral";
  volume: {
    current: number;
    average: number;
  };
  atr: ATRSnapshot;
  ema: {
    ema20: EMASnapshot;
    ema50: EMASnapshot;
    ema200: EMASnapshot;
    alignment: "bullish" | "bearish" | "mixed";
  };
  macd: MacdSnapshot;
  rsi: {
    rsi7: RsiSnapshot;
    rsi14: RsiSnapshot;
  };
  bollinger: BollingerSnapshot;
  orderBookPressure: OrderBookPressure;
  multiTimeframe: MultiTimeframeRow[];
}

export interface HybridContext {
  nakedKData: Record<string, NakedKDataset>;
  snapshots: Record<string, HybridSymbolSnapshot>;
}

const TIMEFRAME_CONFIG = [
  { key: "1m", interval: "1m", limit: 240 },
  { key: "3m", interval: "3m", limit: 240 },
  { key: "5m", interval: "5m", limit: 320 },
  { key: "15m", interval: "15m", limit: 240 },
  { key: "30m", interval: "30m", limit: 240 },
  { key: "1h", interval: "1h", limit: 240 },
];

function normalizeTimestamp(raw: number): number {
  if (!Number.isFinite(raw)) {
    return raw;
  }
  // Gate 返回秒级时间戳，Binance 返回毫秒；统一为毫秒便于与 Date.now 对比
  return raw >= 1_000_000_000_000 ? raw : raw * 1000;
}

function intervalToMs(interval: string): number {
  const match = /^(\d+)([smhdw])$/i.exec(interval.trim());
  if (!match) {
    return 0;
  }
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const unitMs =
    unit === "s"
      ? 1000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : unit === "d"
            ? 86_400_000
            : 604_800_000; // w
  return value * unitMs;
}

function filterClosedCandles(
  candles: NormalizedCandle[],
  intervalMs: number,
  now: number,
): NormalizedCandle[] {
  if (!candles.length || intervalMs <= 0) {
    return candles;
  }
  return candles.filter((candle) => candle.openTime + intervalMs <= now);
}

function ensureFinite(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

function normalizeCandles(raw: any[]): NormalizedCandle[] {
  if (!raw || !Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      if (Array.isArray(item)) {
        return {
          openTime: normalizeTimestamp(Number(item[0])),
          open: Number(item[1]),
          high: Number(item[2]),
          low: Number(item[3]),
          close: Number(item[4]),
          volume: Number(item[5]),
        };
      }
      if (item && typeof item === "object") {
        return {
          openTime: normalizeTimestamp(
            Number(item.t ?? item.openTime ?? item[0]),
          ),
          open: Number(item.o ?? item.open ?? item[1]),
          high: Number(item.h ?? item.high ?? item[2]),
          low: Number(item.l ?? item.low ?? item[3]),
          close: Number(item.c ?? item.close ?? item[4]),
          volume: Number(item.v ?? item.volume ?? item[5] ?? 0),
        };
      }
      return null;
    })
    .filter(
      (entry: NormalizedCandle | null): entry is NormalizedCandle =>
        !!entry &&
        Number.isFinite(entry.open) &&
        Number.isFinite(entry.high) &&
        Number.isFinite(entry.low) &&
        Number.isFinite(entry.close),
    )
    .sort((a, b) => a.openTime - b.openTime);
}

function calculateEMA(values: number[], period: number): number {
  if (!values.length || period <= 0) return 0;
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ensureFinite(ema);
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
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  return ensureFinite(Math.max(0, Math.min(100, rsi)));
}

function calculateMACD(values: number[]): MacdSnapshot {
  if (values.length < 35) {
    return {
      macd: 0,
      signal: 0,
      histogram: 0,
      momentum: "neutral",
    };
  }
  const macdSeries: number[] = [];
  for (let i = 26; i <= values.length; i++) {
    const slice = values.slice(0, i);
    const ema12 = calculateEMA(slice, 12);
    const ema26 = calculateEMA(slice, 26);
    macdSeries.push(ema12 - ema26);
  }
  const macdValue = macdSeries[macdSeries.length - 1];
  const signalSeries: number[] = [];
  for (let i = 9; i <= macdSeries.length; i++) {
    const slice = macdSeries.slice(0, i);
    signalSeries.push(calculateEMA(slice, 9));
  }
  const signal = signalSeries[signalSeries.length - 1] || 0;
  const histogram = macdValue - signal;
  const prevHistogram = macdSeries.length > 1 ? macdSeries[macdSeries.length - 2] - (signalSeries[signalSeries.length - 2] || 0) : histogram;
  const momentum: MacdSnapshot["momentum"] =
    histogram > prevHistogram + 0.0001
      ? "expanding"
      : histogram < prevHistogram - 0.0001
        ? "contracting"
        : "neutral";
  return {
    macd: ensureFinite(macdValue),
    signal: ensureFinite(signal),
    histogram: ensureFinite(histogram),
    momentum,
  };
}

function calculateATR(candles: NormalizedCandle[], period: number): ATRSnapshot {
  if (candles.length < period + 2) {
    return {
      value: 0,
      previous: 0,
      percent: 0,
      direction: "flat",
      delta: 0,
    };
  }
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prev.close),
      Math.abs(current.low - prev.close),
    );
    trs.push(tr);
  }
  const atrValues: number[] = [];
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  atrValues.push(atr);
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    atrValues.push(atr);
  }
  const price = candles[candles.length - 1].close;
  const current = atrValues[atrValues.length - 1];
  const previous = atrValues.length > 1 ? atrValues[atrValues.length - 2] : current;
  const direction: ATRSnapshot["direction"] =
    current > previous * 1.01
      ? "up"
      : current < previous * 0.99
        ? "down"
        : "flat";
  const percent = price > 0 ? (current / price) * 100 : 0;
  return {
    value: ensureFinite(current),
    previous: ensureFinite(previous),
    percent: ensureFinite(percent),
    direction,
    delta: ensureFinite(current - previous),
  };
}

function calculateBollinger(values: number[], period: number = 20): BollingerSnapshot {
  if (values.length < period) {
    return {
      upper: 0,
      lower: 0,
      bandwidthPercent: 0,
    };
  }
  const recent = values.slice(-period);
  const mean = recent.reduce((a, b) => a + b, 0) / period;
  const variance =
    recent.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period;
  const stddev = Math.sqrt(variance);
  const upper = mean + 2 * stddev;
  const lower = mean - 2 * stddev;
  const bandwidthPercent = mean !== 0 ? ((upper - lower) / mean) * 100 : 0;
  return {
    upper: ensureFinite(upper),
    lower: ensureFinite(lower),
    bandwidthPercent: ensureFinite(bandwidthPercent),
  };
}

function buildTrendSnapshot(
  values: number[],
  period: number,
  label: string,
): EMASnapshot {
  const current = calculateEMA(values, period);
  const previous = calculateEMA(values.slice(0, -1), period);
  const delta = current - previous;
  let direction: EMASnapshot["direction"] = "flat";
  if (delta > 0.0001) direction = "up";
  if (delta < -0.0001) direction = "down";
  return {
    label,
    value: ensureFinite(current),
    previous: ensureFinite(previous),
    direction,
    delta: ensureFinite(delta),
  };
}

function buildRsiSnapshot(values: number[], period: number, label: string): RsiSnapshot {
  const current = calculateRSI(values, period);
  const prevSlice = values.length > 5 ? values.slice(0, -5) : values;
  const previous = calculateRSI(prevSlice, period);
  const delta = current - previous;
  let direction: TrendSnapshot["direction"] = "flat";
  if (delta > 1) direction = "up";
  if (delta < -1) direction = "down";
  return {
    label,
    value: ensureFinite(current),
    previous: ensureFinite(previous),
    direction,
    delta: ensureFinite(delta),
    changeOver5: ensureFinite(delta),
  };
}

function calculateOrderBookPressure(orderBook: any): OrderBookPressure {
  const parseSide = (side: any[]): number => {
    if (!Array.isArray(side)) return 0;
    return side
      .slice(0, 10)
      .reduce((sum, entry) => {
        const size = Array.isArray(entry)
          ? Number.parseFloat(entry[1])
          : Number.parseFloat(entry?.s ?? entry?.size ?? entry?.[1]);
        return sum + (Number.isFinite(size) ? Math.max(size, 0) : 0);
      }, 0);
  };
  const bidVolume = parseSide(orderBook?.bids);
  const askVolume = parseSide(orderBook?.asks);
  const delta = bidVolume - askVolume;
  const ratioRaw =
    askVolume === 0 ? (bidVolume > 0 ? Infinity : 0) : bidVolume / askVolume;
  const safeRatio = Number.isFinite(ratioRaw)
    ? ratioRaw
    : bidVolume > 0
      ? 999
      : 0;
  return {
    bidVolume: ensureFinite(bidVolume),
    askVolume: ensureFinite(askVolume),
    delta: ensureFinite(delta),
    ratio: ensureFinite(safeRatio),
  };
}

async function buildSymbolSnapshot(
  client: ReturnType<typeof createExchangeClient>,
  symbol: string,
): Promise<HybridSymbolSnapshot | null> {
  const contract = `${symbol}_USDT`;

  try {
    const [
      ticker,
      fundingRaw,
      orderBook,
      ...timeframeCandlesRaw
    ] = await Promise.all([
      client.getFuturesTicker(contract),
      client.getFundingRate(contract).catch((error: any) => {
        logger.warn(`获取 ${symbol} 资金费率失败`, error);
        return null;
      }),
      client.getOrderBook(contract, 20).catch((error: any) => {
        logger.warn(`获取 ${symbol} 深度失败`, error);
        return { bids: [], asks: [] };
      }),
      ...TIMEFRAME_CONFIG.map((config) =>
        client
          .getFuturesCandles(contract, config.interval, config.limit)
          .then(normalizeCandles)
          .catch((error: any) => {
            logger.warn(`获取 ${symbol} ${config.interval} K线失败`, error);
            return [];
          }),
      ),
    ]);

    const now = Date.now();
    const candlesByKey: Record<string, NormalizedCandle[]> = {};
    TIMEFRAME_CONFIG.forEach((config, idx) => {
      const rawCandles = timeframeCandlesRaw[idx] as NormalizedCandle[];
      const intervalMs = intervalToMs(config.interval);
      const closedCandles = filterClosedCandles(rawCandles, intervalMs, now);
      candlesByKey[config.key] =
        closedCandles.length > 0 ? closedCandles : rawCandles;
    });

    const mainCandles = candlesByKey["5m"] ?? [];
    if (!mainCandles.length) {
      logger.warn(`${symbol} 缺少主要K线数据，跳过`);
      return null;
    }

    const closes = mainCandles.map((c) => c.close);
    const atr = calculateATR(mainCandles, 14);
    const ema20 = buildTrendSnapshot(closes, 20, "EMA20");
    const ema50 = buildTrendSnapshot(closes, 50, "EMA50");
    const ema200 = buildTrendSnapshot(closes, 200, "EMA200");

    const alignment =
      ema20.value > ema50.value && ema50.value > ema200.value
        ? "bullish"
        : ema20.value < ema50.value && ema50.value < ema200.value
          ? "bearish"
          : "mixed";

    const macd = calculateMACD(closes);
    const rsi7 = buildRsiSnapshot(closes, 7, "RSI7");
    const rsi14 = buildRsiSnapshot(closes, 14, "RSI14");
    const bollinger = calculateBollinger(closes);

    const volumeCurrent = mainCandles[mainCandles.length - 1]?.volume ?? 0;
    const volumeAverage =
      mainCandles.slice(-50).reduce((sum, candle) => sum + candle.volume, 0) /
      Math.min(50, mainCandles.length);

    const fundingRate = Number.parseFloat(
      fundingRaw?.fundingRate ??
        fundingRaw?.rate ??
        fundingRaw?.r ??
        fundingRaw?.value ??
        "0",
    );
    const fundingDirection =
      fundingRate > 0
        ? "positive"
        : fundingRate < 0
          ? "negative"
          : "neutral";

    const multiTimeframe: MultiTimeframeRow[] = TIMEFRAME_CONFIG.map((config) => {
      const candles = candlesByKey[config.key] ?? [];
      if (candles.length === 0) {
        return {
          interval: config.interval,
          currentPrice: 0,
          ema20: 0,
          ema50: 0,
          macd: 0,
          rsi14: 50,
          volume: 0,
          avgVolume: 0,
        };
      }
      const series = candles.map((c) => c.close);
      const ema20Val = calculateEMA(series, 20);
      const ema50Val = calculateEMA(series, 50);
      const macdVal = calculateMACD(series).macd;
      const rsi14Val = calculateRSI(series, 14);
      const avgVolume =
        candles.reduce((sum, c) => sum + c.volume, 0) / candles.length;
      return {
        interval: config.interval,
        currentPrice: candles[candles.length - 1]?.close ?? 0,
        ema20: ensureFinite(ema20Val),
        ema50: ensureFinite(ema50Val),
        macd: ensureFinite(macdVal),
        rsi14: ensureFinite(rsi14Val),
        volume: ensureFinite(candles[candles.length - 1]?.volume ?? 0),
        avgVolume: ensureFinite(avgVolume),
      };
    });

    const orderBookPressure = calculateOrderBookPressure(orderBook);

    const price = Number.parseFloat(ticker?.last || "0");
    const change24h = Number.parseFloat(ticker?.change_percentage || "0");

    return {
      symbol,
      price: ensureFinite(price),
      change24h: ensureFinite(change24h),
      fundingRate: ensureFinite(fundingRate),
      fundingDirection,
      volume: {
        current: ensureFinite(volumeCurrent),
        average: ensureFinite(volumeAverage),
      },
      atr,
      ema: {
        ema20,
        ema50,
        ema200,
        alignment,
      },
      macd,
      rsi: {
        rsi7,
        rsi14,
      },
      bollinger,
      orderBookPressure,
      multiTimeframe,
    };
  } catch (error) {
    logger.error(`构建 ${symbol} 混合上下文失败`, error as any);
    return null;
  }
}

export async function buildHybridContext(symbols: string[]): Promise<HybridContext> {
  const client = createExchangeClient();
  const nakedKData = await collectNakedKData(symbols);
  const snapshotsEntries = await Promise.all(
    symbols.map(async (symbol): Promise<[string, HybridSymbolSnapshot] | null> => {
      const snapshot = await buildSymbolSnapshot(client, symbol);
      return snapshot ? [symbol, snapshot] : null;
    }),
  );
  const snapshots: Record<string, HybridSymbolSnapshot> = {};
  for (const entry of snapshotsEntries) {
    if (entry) {
      const [symbol, snapshot] = entry;
      snapshots[symbol] = snapshot;
    }
  }
  return {
    nakedKData,
    snapshots,
  };
}
