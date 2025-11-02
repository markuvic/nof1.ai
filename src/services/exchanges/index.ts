import { createPinoLogger } from "@voltagent/logger";
import { createGateExchangeClient } from "./gateExchangeClient";
import { createBinanceExchangeClient } from "./binanceExchangeClient";
import type { ExchangeClient, ExchangeId, ExchangeOrderParams } from "./types";

const logger = createPinoLogger({
  name: "exchange-factory",
  level: "info",
});

let cachedClient: ExchangeClient | null = null;
let cachedExchange: ExchangeId | null = null;

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

export function createExchangeClient(): ExchangeClient {
  const exchangeId = getActiveExchangeId();

  if (cachedClient && cachedExchange === exchangeId) {
    return cachedClient;
  }

  if (exchangeId === "binance") {
    cachedClient = createBinanceExchangeClient();
  } else {
    cachedClient = createGateExchangeClient();
  }

  cachedExchange = exchangeId;
  logger.info(`已选择交易所: ${exchangeId}`);

  return cachedClient;
}

export function resetExchangeClientCache() {
  cachedClient = null;
  cachedExchange = null;
}

export type { ExchangeClient, ExchangeId, ExchangeOrderParams };
