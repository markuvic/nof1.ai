import { createPinoLogger } from "@voltagent/logger";
import { createExchangeClient, getActiveExchangeId } from "../exchanges";
import {
  deriveStartTime,
  loadKlineCache,
  mergeCandles,
  saveKlineCache,
  type KlineCacheConfig,
} from "../marketDataCache";
import { intervalToMs } from "../../utils/timeUtils";
import type { QuantAgentInterval } from "../../config/quantAgentConfig";

export interface QuantCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FrameDataset {
  frame: string;
  candles: QuantCandle[];
}

export interface SymbolMarketSnapshot {
  symbol: string;
  frames: FrameDataset[];
  fetchedAt: number;
}

const logger = createPinoLogger({
  name: "quant-market-data",
  level: (process.env.LOG_LEVEL as any) || "info",
});

function normalizeCandles(raw: any[]): QuantCandle[] {
  if (!raw || !Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (Array.isArray(entry)) {
        return {
          openTime: Number(entry[0]),
          open: Number(entry[1]),
          high: Number(entry[2]),
          low: Number(entry[3]),
          close: Number(entry[4]),
          volume: Number(entry[5]),
        };
      }
      if (entry && typeof entry === "object") {
        return {
          openTime: Number(entry.t ?? entry.openTime ?? entry.time ?? entry[0]),
          open: Number(entry.o ?? entry.open ?? entry[1]),
          high: Number(entry.h ?? entry.high ?? entry[2]),
          low: Number(entry.l ?? entry.low ?? entry[3]),
          close: Number(entry.c ?? entry.close ?? entry[4]),
          volume: Number(entry.v ?? entry.volume ?? entry[5] ?? 0),
        };
      }
      return null;
    })
    .filter(
      (candle: QuantCandle | null): candle is QuantCandle =>
        !!candle &&
        Number.isFinite(candle.open) &&
        Number.isFinite(candle.high) &&
        Number.isFinite(candle.low) &&
        Number.isFinite(candle.close),
    )
    .sort((a, b) => a.openTime - b.openTime);
}

async function fetchCandlesRaw(
  contract: string,
  interval: string,
  limit: number,
  startTime?: number,
): Promise<QuantCandle[]> {
  const client = createExchangeClient();
  const raw = await client.getFuturesCandles(contract, interval, limit, {
    startTime,
  });
  return normalizeCandles(raw);
}

export async function loadSymbolFrames(
  symbol: string,
  intervals: QuantAgentInterval[],
  reportDir: string,
): Promise<SymbolMarketSnapshot> {
  const exchangeId = getActiveExchangeId();
  const contract = `${symbol}_USDT`;
  const frames: FrameDataset[] = [];

  await Promise.all(
    intervals.map(async ({ frame, limit }) => {
      const retention = Math.max(limit + 16, Math.round(limit * 1.25));
      const cacheConfig: KlineCacheConfig = {
        exchangeId,
        profile: `quant-${frame}`,
        baseDir: reportDir,
        retention,
      };

      let candles = loadKlineCache(symbol, frame, cacheConfig);
      const intervalMs = intervalToMs(frame);
      let cacheChanged = false;

      if (candles.length < limit) {
        try {
          const fetchCount = Math.max(limit * 2, retention);
          candles = await fetchCandlesRaw(contract, frame, fetchCount);
          cacheChanged = true;
        } catch (error) {
          logger.warn(`初始化 ${symbol} ${frame} K线失败`, error as any);
        }
      }

      if (intervalMs > 0 && candles.length > 0) {
        const startTime = deriveStartTime(candles, intervalMs);
        if (startTime && startTime < Date.now() + intervalMs) {
          try {
            const updates = await fetchCandlesRaw(contract, frame, limit, startTime);
            if (updates.length) {
              candles = mergeCandles(candles, updates);
              cacheChanged = true;
            }
          } catch (error) {
            logger.warn(`增量获取 ${symbol} ${frame} 失败`, error as any);
          }
        }
      }

      if (cacheChanged) {
        saveKlineCache(symbol, frame, candles, cacheConfig);
      }

      frames.push({
        frame,
        candles: candles.slice(-limit),
      });
    }),
  );

  return {
    symbol,
    frames,
    fetchedAt: Date.now(),
  };
}
