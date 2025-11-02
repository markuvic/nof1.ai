import { createPinoLogger } from "@voltagent/logger";
import { createGateExchangeClient } from "./gateExchangeClient";
import { createBinanceExchangeClient } from "./binanceExchangeClient";
import { createBinanceDryRunExchangeClient } from "./dryRunExchangeClient";
import type { ExchangeClient, ExchangeId, ExchangeOrderParams } from "./types";

const logger = createPinoLogger({
  name: "exchange-factory",
  level: "info",
});

let cachedClient: ExchangeClient | null = null;
let cachedClientKey: string | null = null;

function normalizeExchangeId(raw?: string | null): ExchangeId {
  if (!raw) return "gate";
  const value = raw.toLowerCase();
  if (value === "binance" || value === "bnb") return "binance";
  if (value === "gate" || value === "gateio" || value === "gate.io") {
    return "gate";
  }
  logger.warn(
    `未知的交易所标识 "${raw}"，回退使用 Gate.io。支持值: gate | binance`,
  );
  return "gate";
}

export function getActiveExchangeId(): ExchangeId {
  const envValue =
    process.env.EXCHANGE_PROVIDER ??
    process.env.TRADING_EXCHANGE ??
    process.env.EXCHANGE_ID;
  return normalizeExchangeId(envValue);
}

export function isDryRunMode(): boolean {
  return (
    process.env.EXCHANGE_DRY_RUN === "true" ||
    process.env.DRY_RUN === "true" ||
    process.env.DRY_RUN_MODE === "true"
  );
}

export function createExchangeClient(): ExchangeClient {
  const exchangeId = getActiveExchangeId();
  const dryRunEnabled = isDryRunMode() && exchangeId === "binance";
  const key = dryRunEnabled ? `${exchangeId}-dry-run` : exchangeId;

  if (cachedClient && cachedClientKey === key) {
    return cachedClient;
  }

  if (dryRunEnabled) {
    cachedClient = createBinanceDryRunExchangeClient();
    logger.info("已启用 Binance Dry-Run 模式，所有交易将在本地模拟执行。");
  } else if (exchangeId === "binance") {
    cachedClient = createBinanceExchangeClient();
  } else {
    cachedClient = createGateExchangeClient();
  }

  cachedClientKey = key;
  logger.info(`已选择交易所: ${key}`);

  return cachedClient;
}

export function resetExchangeClientCache() {
  cachedClient = null;
  cachedClientKey = null;
}

export type { ExchangeClient, ExchangeId, ExchangeOrderParams };
