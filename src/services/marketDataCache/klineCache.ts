import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { createPinoLogger } from "@voltagent/logger";
import type { ExchangeId } from "../exchanges";

export interface KlineEntry {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface KlineCacheConfig {
  exchangeId: ExchangeId;
  profile: string;
  baseDir?: string;
  retention?: number;
}

const logger = createPinoLogger({
  name: "kline-cache",
  level: (process.env.LOG_LEVEL as any) || "info",
});

const DEFAULT_BASE_DIR = ".voltagent/kline-cache";

function resolveCachePath(
  symbol: string,
  interval: string,
  config: KlineCacheConfig,
): string {
  const baseDir = config.baseDir
    ? resolvePath(process.cwd(), config.baseDir)
    : resolvePath(process.cwd(), DEFAULT_BASE_DIR);
  return resolvePath(
    baseDir,
    config.exchangeId,
    config.profile,
    symbol.toUpperCase(),
    `${interval}.json`,
  );
}

export function loadKlineCache(
  symbol: string,
  interval: string,
  config: KlineCacheConfig,
): KlineEntry[] {
  const path = resolveCachePath(symbol, interval, config);
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) => ({
        openTime: Number(item.openTime ?? item[0]),
        open: Number(item.open ?? item[1]),
        high: Number(item.high ?? item[2]),
        low: Number(item.low ?? item[3]),
        close: Number(item.close ?? item[4]),
        volume: Number(item.volume ?? item[5]),
      }))
      .filter(
        (entry) =>
          Number.isFinite(entry.openTime) &&
          Number.isFinite(entry.open) &&
          Number.isFinite(entry.high) &&
          Number.isFinite(entry.low) &&
          Number.isFinite(entry.close),
      )
      .sort((a, b) => a.openTime - b.openTime);
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      logger.warn(
        `读取 K 线缓存失败: ${symbol} ${interval} @ ${config.profile}`,
        error,
      );
    }
    return [];
  }
}

function ensureDir(path: string) {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function clearKlineCache(
  symbol: string,
  interval: string,
  config: KlineCacheConfig,
) {
  const path = resolveCachePath(symbol, interval, config);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch (error) {
      logger.warn(`删除 K 线缓存失败: ${path}`, error as any);
    }
  }
}

export function saveKlineCache(
  symbol: string,
  interval: string,
  candles: KlineEntry[],
  config: KlineCacheConfig,
) {
  const path = resolveCachePath(symbol, interval, config);
  ensureDir(path);
  const retention = Math.max(0, config.retention ?? candles.length);
  const trimmed =
    retention > 0 ? candles.slice(-retention) : [...candles].sort((a, b) => a.openTime - b.openTime);
  writeFileSync(
    path,
    JSON.stringify(trimmed.map((candle) => ({
      openTime: candle.openTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    }))),
    "utf8",
  );
}

export function mergeCandles(existing: KlineEntry[], incoming: KlineEntry[]): KlineEntry[] {
  if (!incoming.length) {
    return existing;
  }
  const map = new Map<number, KlineEntry>();
  for (const candle of existing) {
    map.set(candle.openTime, candle);
  }
  for (const candle of incoming) {
    map.set(candle.openTime, candle);
  }
  return Array.from(map.values()).sort((a, b) => a.openTime - b.openTime);
}

export function deriveStartTime(
  existing: KlineEntry[],
  intervalMs: number,
): number | undefined {
  if (existing.length === 0) {
    return undefined;
  }
  const last = existing[existing.length - 1];
  return last.openTime + intervalMs;
}
