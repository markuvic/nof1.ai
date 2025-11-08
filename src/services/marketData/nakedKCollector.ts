import { createPinoLogger } from "@voltagent/logger";
import { createExchangeClient, getActiveExchangeId } from "../exchanges";
import {
  loadKlineCache,
  saveKlineCache,
  mergeCandles,
  deriveStartTime,
  KlineCacheConfig,
  KlineEntry,
} from "../marketDataCache";
import { getKlineProfile, getRetentionFor } from "../../config/klineProfiles";
import { intervalToMs } from "../../utils/timeUtils";

const logger = createPinoLogger({
  name: "naked-k-collector",
  level: (process.env.LOG_LEVEL as any) || "info",
});

export interface NakedKFrame {
  interval: string;
  candles: KlineEntry[];
}

export interface NakedKDataset {
  profileId: string;
  frames: Record<string, NakedKFrame>;
}

type RawCandles = any[] | undefined | null;

function normalizeCandles(raw: RawCandles): KlineEntry[] {
  if (!raw || !Array.isArray(raw)) return [];
  return raw
    .map((item: any) => {
      if (Array.isArray(item)) {
        return {
          openTime: Number(item[0]),
          open: Number(item[1]),
          high: Number(item[2]),
          low: Number(item[3]),
          close: Number(item[4]),
          volume: Number(item[5]),
        };
      }
      if (item && typeof item === "object") {
        return {
          openTime: Number(
            item.openTime ?? item.t ?? item.time ?? item.timestamp ?? item[0],
          ),
          open: Number(item.open ?? item.o ?? item[1]),
          high: Number(item.high ?? item.h ?? item[2]),
          low: Number(item.low ?? item.l ?? item[3]),
          close: Number(item.close ?? item.c ?? item[4]),
          volume: Number(item.volume ?? item.v ?? item[5] ?? 0),
        };
      }
      return null;
    })
    .filter(
      (entry: KlineEntry | null): entry is KlineEntry =>
        entry !== null &&
        Number.isFinite(entry.openTime) &&
        Number.isFinite(entry.open) &&
        Number.isFinite(entry.high) &&
        Number.isFinite(entry.low) &&
        Number.isFinite(entry.close),
    )
    .sort((a, b) => a.openTime - b.openTime);
}

async function fetchCandles(
  client: ReturnType<typeof createExchangeClient>,
  contract: string,
  interval: string,
  limit: number,
  options?: { startTime?: number },
): Promise<KlineEntry[]> {
  const raw = await client.getFuturesCandles(contract, interval, limit, {
    startTime: options?.startTime,
  });
  return normalizeCandles(raw);
}

export async function collectNakedKData(
  symbols: string[],
): Promise<Record<string, NakedKDataset>> {
  const exchangeId = getActiveExchangeId();
  const profile = getKlineProfile();
  const client = createExchangeClient();

  const out: Record<string, NakedKDataset> = {};

  for (const symbol of symbols) {
    const contract = `${symbol}_USDT`;
    const frames: Record<string, NakedKFrame> = {};

    await Promise.all(
      profile.intervals.map(async ({ frame, limit }) => {
        const retention = getRetentionFor(frame, profile);
        const cacheConfig: KlineCacheConfig = {
          exchangeId,
          profile: profile.id,
          retention,
        };

        let cache = loadKlineCache(symbol, frame, cacheConfig);
        const intervalMs = intervalToMs(frame);
        let cacheChanged = false;

        if (cache.length < limit) {
          try {
            const fetchCount = Math.max(limit, retention);
            const candles = await fetchCandles(
              client,
              contract,
              frame,
              fetchCount,
            );
            if (candles.length) {
              cache = candles;
              cacheChanged = true;
            }
          } catch (error) {
            logger.warn(
              `初始化裸K缓存失败: ${symbol} ${frame} (${profile.id})`,
              error as any,
            );
          }
        }

        if (intervalMs > 0 && cache.length > 0) {
          const startTime = deriveStartTime(cache, intervalMs);
          if (startTime && startTime < Date.now()) {
            try {
              const updates = await fetchCandles(client, contract, frame, limit, {
                startTime,
              });
              if (updates.length) {
                cache = mergeCandles(cache, updates);
                cacheChanged = true;
              }
            } catch (error) {
              logger.warn(
                `增量更新裸K缓存失败: ${symbol} ${frame} (${profile.id})`,
                error as any,
              );
            }
          }
        }

        if (cacheChanged) {
          saveKlineCache(symbol, frame, cache, cacheConfig);
        }

        const candlesForPrompt = cache.slice(-limit);
        frames[frame] = {
          interval: frame,
          candles: candlesForPrompt,
        };
      }),
    );

    out[symbol] = {
      profileId: profile.id,
      frames,
    };
  }

  return out;
}
