import { createHmac } from "node:crypto";
import { createPinoLogger } from "@voltagent/logger";
import { RISK_PARAMS } from "../../config/riskParams";
import type { ExchangeClient, ExchangeOrderParams } from "./types";

type HttpMethod = "GET" | "POST" | "DELETE";

interface RequestOptions {
  path: string;
  method?: HttpMethod;
  params?: Record<string, string | number | boolean | undefined>;
  signed?: boolean;
  retries?: number;
}

interface SymbolMeta {
  contract: string;
  symbol: string;
  baseAsset: string;
  stepSize: number;
  minQty: number;
  maxQty: number;
  quantityPrecision: number;
  pricePrecision: number;
  tickSize: number;
  minNotional: number;
  maxLeverage: number;
}

interface NormalizedOrder {
  id: string;
  contract: string;
  size: string;
  left: string;
  price: string;
  status: string;
  tif?: string;
  avgFillPrice?: string;
  reduceOnly?: boolean;
  side?: string;
  type?: string;
  clientOrderId?: string;
  updateTime?: string;
  positionSide?: "LONG" | "SHORT" | "BOTH";
}

const logger = createPinoLogger({
  name: "binance-client",
  level: "info",
});

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapOrderStatus(status: string): string {
  switch (status) {
    case "FILLED":
      return "finished";
    case "NEW":
    case "PARTIALLY_FILLED":
    case "PENDING_NEW":
      return "open";
    case "CANCELED":
    case "EXPIRED":
    case "REJECTED":
    default:
      return "cancelled";
  }
}

function formatNumber(value: number, precision: number): string {
  return value.toFixed(precision).replace(/\.?0+$/, "");
}

function stripExpirySuffix(value: string): string {
  return value.replace(/[_-]\d+$/, "");
}

function toContract(symbol: string): string {
  const upper = stripExpirySuffix(symbol.toUpperCase());
  if (upper.endsWith("USDT")) {
    return `${upper.slice(0, -4)}_USDT`;
  }
  return upper;
}

function toSymbol(contract: string): string {
  const upper = stripExpirySuffix(contract.toUpperCase().replace(/\s/g, ""));
  return upper.replace(/_/g, "");
}

export class BinanceExchangeClient implements ExchangeClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;
  private positionMode: "HEDGE" | "ONE_WAY" | null = null;
  private exchangeInfoCache: any | null = null;
  private exchangeInfoPromise: Promise<any> | null = null;
  private readonly symbolMetaCache = new Map<string, SymbolMeta>();
  private readonly orderSymbolCache = new Map<string, {
    symbol: string;
    positionSide?: "LONG" | "SHORT" | "BOTH";
  }>();

  private cacheOrderLookup(
    orderId: string | number | undefined,
    clientOrderId: string | undefined,
    symbol: string,
    positionSide?: "LONG" | "SHORT" | "BOTH",
  ) {
    const value = { symbol, positionSide } as const;
    if (orderId !== undefined && orderId !== null) {
      this.orderSymbolCache.set(orderId.toString(), value);
    }
    if (clientOrderId) {
      this.orderSymbolCache.set(clientOrderId, value);
    }
  }

  constructor(apiKey: string, apiSecret: string) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    const isTestnet = process.env.BINANCE_USE_TESTNET === "true";
    this.baseUrl = isTestnet
      ? "https://testnet.binancefuture.com"
      : "https://fapi.binance.com";
    const envMode = process.env.BINANCE_POSITION_MODE?.toUpperCase();
    if (envMode === "HEDGE" || envMode === "ONE_WAY") {
      this.positionMode = envMode;
    }

    const timeoutEnv = Number.parseInt(
      process.env.BINANCE_TIMEOUT_MS || "15000",
      10,
    );
    this.timeoutMs = Number.isFinite(timeoutEnv) && timeoutEnv > 0 ? timeoutEnv : 15000;

    const retriesEnv = Number.parseInt(
      process.env.BINANCE_MAX_RETRIES || "2",
      10,
    );
    this.maxRetries = Number.isFinite(retriesEnv) && retriesEnv >= 0 ? retriesEnv : 2;
    logger.info(`Binance API 客户端初始化完成 (${isTestnet ? "测试网" : "正式网"})`);
  }

  private async request<T>({
    path,
    method = "GET",
    params,
    signed = false,
    retries,
  }: RequestOptions): Promise<T> {
    const maxAttempts = Math.max(0, retries ?? this.maxRetries);
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      const searchParams = new URLSearchParams();
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          if (value === undefined || value === null) continue;
          searchParams.append(key, String(value));
        }
      }

      if (signed) {
        searchParams.append("timestamp", Date.now().toString());
        const recvWindow = Number.parseInt(
          process.env.BINANCE_RECV_WINDOW || "5000",
          10,
        );
        if (Number.isFinite(recvWindow) && recvWindow > 0) {
          searchParams.append("recvWindow", recvWindow.toString());
        }
        const signaturePayload = searchParams.toString();
        const signature = createHmac("sha256", this.apiSecret)
          .update(signaturePayload)
          .digest("hex");
        searchParams.append("signature", signature);
      }

      let url = `${this.baseUrl}${path}`;
      const init: RequestInit = { method, headers: {} };

      if (method === "GET" || method === "DELETE") {
        const qs = searchParams.toString();
        if (qs) {
          url += `?${qs}`;
        }
      } else {
        const body = searchParams.toString();
        init.body = body;
        (init.headers as Record<string, string>)["Content-Type"] =
          "application/x-www-form-urlencoded";
      }

      if (signed || this.apiKey) {
        (init.headers as Record<string, string>)["X-MBX-APIKEY"] = this.apiKey;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      (init as any).signal = controller.signal;

      try {
        const res = await fetch(url, init);
        clearTimeout(timeout);
        const text = await res.text();

        if (!res.ok) {
          throw new Error(`Binance API error ${res.status}: ${text}`);
        }

        try {
          return JSON.parse(text) as T;
        } catch {
          return text as unknown as T;
        }
      } catch (error) {
        clearTimeout(timeout);
        lastError = error;
        const isLastAttempt = attempt >= maxAttempts;
        const isAbort = (error as any)?.name === "AbortError";

        if (!isLastAttempt) {
          const waitMs = 500 * (attempt + 1);
          logger.warn(
            `Binance 请求失败 (${path})，${isAbort ? "超时" : ""} ${waitMs}ms 后重试 (${attempt + 1}/${maxAttempts})`,
          );
          await delay(waitMs);
          continue;
        }
        break;
      }
    }

    throw lastError;
  }

  private async getExchangeInfo(): Promise<any> {
    if (this.exchangeInfoCache) {
      return this.exchangeInfoCache;
    }
    if (this.exchangeInfoCache) {
      return this.exchangeInfoCache;
    }

    if (this.exchangeInfoPromise) {
      return this.exchangeInfoPromise;
    }

    this.exchangeInfoPromise = this.request<any>({
      path: "/fapi/v1/exchangeInfo",
      retries: 1,
    })
      .then((data) => {
        this.exchangeInfoCache = data;
        this.exchangeInfoPromise = null;
        return data;
      })
      .catch((error) => {
        this.exchangeInfoPromise = null;
        throw error;
      });

    return this.exchangeInfoPromise;
  }

  private async getPositionMode(): Promise<"HEDGE" | "ONE_WAY"> {
    if (this.positionMode) {
      return this.positionMode;
    }

    try {
      const data = await this.request<{ dualSidePosition: string | boolean }>({
        path: "/fapi/v1/positionSide/dual",
        signed: true,
        retries: 1,
      });
      const dualValue =
        typeof data.dualSidePosition === "boolean"
          ? data.dualSidePosition
          : data.dualSidePosition?.toLowerCase() === "true";
      this.positionMode = dualValue ? "HEDGE" : "ONE_WAY";
    } catch (error) {
      logger.warn(`获取 Binance 持仓模式失败，默认使用单向模式: ${(error as Error).message}`);
      this.positionMode = "ONE_WAY";
    }

    return this.positionMode;
  }

  private async getSymbolMeta(contract: string): Promise<SymbolMeta> {
    const normalized = contract.toUpperCase();
    if (this.symbolMetaCache.has(normalized)) {
      return this.symbolMetaCache.get(normalized)!;
    }

    const symbolName = toSymbol(normalized);
    const exchangeInfo = await this.getExchangeInfo();
    const symbolInfo = exchangeInfo.symbols?.find(
      (item: any) => item.symbol === symbolName,
    );

    if (!symbolInfo) {
      throw new Error(`无法获取 Binance 合约信息: ${normalized}`);
    }

    const lotSizeFilter =
      symbolInfo.filters?.find(
        (filter: any) => filter.filterType === "LOT_SIZE",
      ) ?? {};
    const marketLotSizeFilter =
      symbolInfo.filters?.find(
        (filter: any) => filter.filterType === "MARKET_LOT_SIZE",
      ) ?? {};
    const priceFilter =
      symbolInfo.filters?.find(
        (filter: any) => filter.filterType === "PRICE_FILTER",
      ) ?? {};
    const notionalFilter =
      symbolInfo.filters?.find(
        (filter: any) => filter.filterType === "MIN_NOTIONAL",
      ) ?? {};

    const stepSize = Number.parseFloat(lotSizeFilter.stepSize ?? "0.001");
    const minQty = Number.parseFloat(
      lotSizeFilter.minQty ?? marketLotSizeFilter.minQty ?? stepSize.toString(),
    );
    const maxQty = Number.parseFloat(
      lotSizeFilter.maxQty ?? marketLotSizeFilter.maxQty ?? "1000000",
    );
    const tickSize = Number.parseFloat(priceFilter.tickSize ?? "0.1");
    const minNotional = Number.parseFloat(notionalFilter.notional ?? "5");
    const quantityPrecision =
      symbolInfo.quantityPrecision ??
      Math.max(0, Math.min(8, Math.round(-Math.log10(stepSize))));
    const pricePrecision = symbolInfo.pricePrecision ?? 2;

    const meta: SymbolMeta = {
      contract: normalized,
      symbol: symbolInfo.symbol,
      baseAsset: symbolInfo.baseAsset,
      stepSize,
      minQty,
      maxQty,
      quantityPrecision,
      pricePrecision,
      tickSize,
      minNotional,
      maxLeverage: Number.parseInt(symbolInfo.maxLeverage ?? "125", 10),
    };

    this.symbolMetaCache.set(normalized, meta);
    return meta;
  }

  private normalizeOrder(raw: any, meta: SymbolMeta): NormalizedOrder {
    const sizeContracts = Math.round(
      Number.parseFloat(raw.origQty || "0") / meta.stepSize,
    );
    const executedContracts = Math.round(
      Number.parseFloat(raw.executedQty || "0") / meta.stepSize,
    );
    const remainingContracts = Math.max(sizeContracts - executedContracts, 0);
    const status = mapOrderStatus(raw.status || raw.orderStatus || "NEW");

    const normalized: NormalizedOrder = {
      id: raw.orderId?.toString() || raw.clientOrderId || "",
      contract: toContract(raw.symbol || meta.symbol),
      size: (raw.side === "SELL" ? -sizeContracts : sizeContracts).toString(),
      left: remainingContracts.toString(),
      price: raw.price || raw.avgPrice || raw.stopPrice || "0",
      status,
      tif: raw.timeInForce?.toLowerCase(),
      avgFillPrice: raw.avgPrice || raw.price || "0",
      reduceOnly: raw.reduceOnly ?? false,
      side: raw.side,
      type: raw.type,
      clientOrderId: raw.clientOrderId,
      updateTime: raw.updateTime
        ? new Date(raw.updateTime).toISOString()
        : new Date().toISOString(),
      positionSide:
        raw.positionSide && typeof raw.positionSide === "string"
          ? (raw.positionSide.toUpperCase() as "LONG" | "SHORT" | "BOTH")
          : undefined,
    };

    this.cacheOrderLookup(raw.orderId, raw.clientOrderId, meta.symbol, normalized.positionSide);

    return normalized;
  }

  private async resolveOrder(orderId: string): Promise<{
    symbol: string;
    meta: SymbolMeta;
    identifier: Record<string, string | number>;
    positionSide?: "LONG" | "SHORT" | "BOTH";
    orderData?: any;
  }> {
    const identifier: Record<string, string | number> = /^\d+$/.test(orderId)
      ? { orderId: Number.parseInt(orderId, 10) }
      : { origClientOrderId: orderId };

    const cached = this.orderSymbolCache.get(orderId);
    if (cached) {
      const meta = await this.getSymbolMeta(toContract(cached.symbol));
      return { symbol: cached.symbol, meta, identifier, positionSide: cached.positionSide };
    }
    const openOrders = await this.request<any[]>({
      path: "/fapi/v1/openOrders",
      signed: true,
    });
    const matched = openOrders.find((order: any) => {
      if ("orderId" in identifier) {
        return order.orderId?.toString() === identifier.orderId?.toString();
      }
      return order.clientOrderId === identifier.origClientOrderId;
    });

    if (matched) {
      const meta = await this.getSymbolMeta(toContract(matched.symbol));
      const positionSide = matched.positionSide as "LONG" | "SHORT" | "BOTH" | undefined;
      this.cacheOrderLookup(matched.orderId, matched.clientOrderId, matched.symbol, positionSide);
      this.orderSymbolCache.set(orderId, { symbol: matched.symbol, positionSide });
      return { symbol: matched.symbol, meta, identifier, orderData: matched, positionSide };
    }

    const symbols = RISK_PARAMS.TRADING_SYMBOLS.map((symbol) =>
      toSymbol(`${symbol}_USDT`),
    );

    const positionMode = await this.getPositionMode();
    const candidateSides: Array<"LONG" | "SHORT" | "BOTH" | undefined> =
      positionMode === "HEDGE"
        ? ["LONG", "SHORT", "BOTH"]
        : [undefined];

    for (const symbol of symbols) {
      for (const candidatePositionSide of candidateSides) {
        try {
          const params: Record<string, string | number> = {
            symbol,
            ...identifier,
          };
          if (candidatePositionSide && positionMode === "HEDGE") {
            params.positionSide = candidatePositionSide;
          }
          const orderData = await this.request<any>({
            path: "/fapi/v1/order",
            method: "GET",
            params,
            signed: true,
          });
          const meta = await this.getSymbolMeta(toContract(symbol));
          const positionSide = (orderData.positionSide
            ? (orderData.positionSide.toUpperCase() as "LONG" | "SHORT" | "BOTH")
            : candidatePositionSide) as "LONG" | "SHORT" | "BOTH" | undefined;
          this.cacheOrderLookup(orderData.orderId, orderData.clientOrderId, symbol, positionSide);
          this.orderSymbolCache.set(orderId, { symbol, positionSide });
          return { symbol, meta, identifier, orderData, positionSide };
        } catch (error: any) {
          const message = (error as Error).message || "";
          const notFound = message.includes("-2013") || message.includes("-2011");
          if (notFound && candidatePositionSide && positionMode === "HEDGE") {
            // 在对冲模式下尝试下一个 positionSide
            continue;
          }
          if (!notFound) {
            logger.warn(
              `尝试解析订单 ${orderId} 时在 ${symbol}${candidatePositionSide ? ` (${candidatePositionSide})` : ""} 遇到错误: ${message}`,
            );
          }
        }
      }
    }

    throw new Error(`无法定位订单 ${orderId} 对应的交易对`);
  }

  async getFuturesTicker(contract: string) {
    const symbol = toSymbol(contract);
    const [ticker24h, premium] = await Promise.all([
      this.request<any>({
        path: "/fapi/v1/ticker/24hr",
        params: { symbol },
      }),
      this.request<any>({
        path: "/fapi/v1/premiumIndex",
        params: { symbol },
      }),
    ]);

    return {
      contract: toContract(symbol),
      last: ticker24h.lastPrice,
      open: ticker24h.openPrice,
      high: ticker24h.highPrice,
      low: ticker24h.lowPrice,
      change_percentage: ticker24h.priceChangePercent,
      volume_24h: ticker24h.volume,
      markPrice: premium.markPrice,
      indexPrice: premium.indexPrice,
      time: premium.time,
    };
  }

  async getFuturesCandles(
    contract: string,
    interval: string = "5m",
    limit: number = 100,
    retries: number = 2,
  ) {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const symbol = toSymbol(contract);
        const data = await this.request<any[]>({
          path: "/fapi/v1/klines",
          params: { symbol, interval, limit },
        });
        return data.map((candle: any[]) => ({
          t: candle[0],
          o: candle[1],
          h: candle[2],
          l: candle[3],
          c: candle[4],
          v: candle[5],
          sum: candle[7],
        }));
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          const waitMs = 200 * (attempt + 1);
          logger.warn(
            `获取 ${contract} K线失败，${waitMs}ms 后重试 (${attempt + 1}/${retries})`,
          );
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      }
    }
    throw lastError;
  }

  async getFuturesAccount() {
    const data = await this.request<any>({
      path: "/fapi/v2/account",
      signed: true,
    });
    return {
      total: data.totalWalletBalance,
      available: data.availableBalance,
      positionMargin: data.totalPositionInitialMargin,
      orderMargin: data.totalOpenOrderInitialMargin,
      unrealisedPnl: data.totalUnrealizedProfit,
      currency: "USDT",
    };
  }

  async getPositions() {
    const data = await this.request<any[]>({
      path: "/fapi/v2/positionRisk",
      signed: true,
    });
    return Promise.all(
      data.map(async (position: any) => {
        const contract = toContract(position.symbol);
        const meta = await this.getSymbolMeta(contract);
        return {
          contract,
          size: Math.round(
            Number.parseFloat(position.positionAmt || "0") / meta.stepSize,
          ).toString(),
          entryPrice: position.entryPrice,
          markPrice: position.markPrice,
          leverage: position.leverage,
          unrealisedPnl: position.unRealizedProfit,
          liqPrice: position.liquidationPrice,
          margin: position.positionInitialMargin ?? position.isolatedMargin ?? "0",
          tif: "gtc",
          update_time: position.updateTime
            ? new Date(position.updateTime).toISOString()
            : new Date().toISOString(),
        };
      }),
    );
  }

  async placeOrder(params: ExchangeOrderParams) {
    const meta = await this.getSymbolMeta(params.contract);
    const symbol = meta.symbol;

    if (!Number.isFinite(params.size) || params.size === 0) {
      throw new Error("订单数量必须为非零数字");
    }

    const absContracts = Math.abs(Math.trunc(params.size));
    const minContracts = Math.max(1, Math.round(meta.minQty / meta.stepSize));
    const maxContracts = Math.max(minContracts, Math.floor(meta.maxQty / meta.stepSize));

    let adjustedContracts = absContracts;
    if (adjustedContracts < minContracts) {
      logger.warn(
        `订单数量 ${adjustedContracts} 小于 Binance 限制 ${minContracts}，自动调整为最小值`,
      );
      adjustedContracts = minContracts;
    }
    if (adjustedContracts > maxContracts) {
      logger.warn(
        `订单数量 ${adjustedContracts} 超过 Binance 限制 ${maxContracts}，自动调整为最大值`,
      );
      adjustedContracts = maxContracts;
    }

    const quantity = adjustedContracts * meta.stepSize;
    const formattedQty = formatNumber(quantity, meta.quantityPrecision);

    const isMarket = !params.price || params.price <= 0;
    const orderParams: Record<string, string> = {
      symbol,
      side: params.size >= 0 ? "BUY" : "SELL",
      type: isMarket ? "MARKET" : "LIMIT",
      quantity: formattedQty,
    };

    if (!isMarket) {
      orderParams.price = formatNumber(
        params.price!,
        meta.pricePrecision,
      );
      orderParams.timeInForce = (params.tif ?? "GTC").toUpperCase();
    }

    const positionMode = await this.getPositionMode();
    if (positionMode === "HEDGE") {
      let positionSide: "LONG" | "SHORT";
      if (params.size >= 0) {
        positionSide = params.reduceOnly ? "SHORT" : "LONG";
      } else {
        positionSide = params.reduceOnly ? "LONG" : "SHORT";
      }
      orderParams.positionSide = positionSide;
    }

    if (params.reduceOnly) {
      orderParams.reduceOnly = "true";
    }

    if (params.stopLoss || params.takeProfit) {
      orderParams.workingType = "CONTRACT_PRICE";
    }

    try {
      const data = await this.request<any>({
        path: "/fapi/v1/order",
        method: "POST",
        params: orderParams,
        signed: true,
      });
      const normalized = this.normalizeOrder(data, meta);
      logger.info(`Binance 下单成功: ${JSON.stringify(normalized)}`);
      return normalized;
    } catch (error: any) {
      logger.error(`Binance 下单失败: ${error.message}`);
      throw new Error(`Binance 下单失败: ${error.message}`);
    }
  }

  async getOrder(orderId: string) {
    const { symbol, meta, identifier, orderData, positionSide } =
      await this.resolveOrder(orderId);

    if (orderData) {
      const normalized = this.normalizeOrder(orderData, meta);
      this.cacheOrderLookup(
        orderData.orderId,
        orderData.clientOrderId,
        symbol,
        normalized.positionSide,
      );
      this.orderSymbolCache.set(orderId, {
        symbol,
        positionSide: normalized.positionSide,
      });
      return normalized;
    }

    const params: Record<string, string | number> = { symbol, ...identifier };
    const mode = await this.getPositionMode();
    if (positionSide && mode === "HEDGE") {
      params.positionSide = positionSide;
    }

    const data = await this.request<any>({
      path: "/fapi/v1/order",
      params,
      signed: true,
    });

    const normalized = this.normalizeOrder(data, meta);
    const resolvedSide = normalized.positionSide ?? positionSide;
    this.cacheOrderLookup(data.orderId, data.clientOrderId, symbol, resolvedSide);
    this.orderSymbolCache.set(orderId, { symbol, positionSide: resolvedSide });
    return normalized;
  }

  async cancelOrder(orderId: string) {
    const { symbol, meta, identifier, positionSide } = await this.resolveOrder(
      orderId,
    );

    const params: Record<string, string | number> = { symbol, ...identifier };
    if (positionSide && (await this.getPositionMode()) === "HEDGE") {
      params.positionSide = positionSide;
    }

    const data = await this.request<any>({
      path: "/fapi/v1/order",
      method: "DELETE",
      params,
      signed: true,
    });
    const normalized = this.normalizeOrder(data, meta);
    const resolvedSide = normalized.positionSide ?? positionSide;
    this.cacheOrderLookup(data.orderId, data.clientOrderId, symbol, resolvedSide);
    this.orderSymbolCache.set(orderId, { symbol, positionSide: resolvedSide });
    return normalized;
  }

  async getOpenOrders(contract?: string) {
    if (contract) {
      const meta = await this.getSymbolMeta(contract);
      const data = await this.request<any[]>({
        path: "/fapi/v1/openOrders",
        params: { symbol: meta.symbol },
        signed: true,
      });
      return data.map((order) => this.normalizeOrder(order, meta));
    }

    const data = await this.request<any[]>({
      path: "/fapi/v1/openOrders",
      signed: true,
    });
    return Promise.all(
      data.map(async (order: any) => {
        const meta = await this.getSymbolMeta(toContract(order.symbol));
        return this.normalizeOrder(order, meta);
      }),
    );
  }

  async setLeverage(contract: string, leverage: number) {
    const meta = await this.getSymbolMeta(contract);
    const level = Math.max(1, Math.min(Math.floor(leverage), meta.maxLeverage));
    return this.request<any>({
      path: "/fapi/v1/leverage",
      method: "POST",
      params: { symbol: meta.symbol, leverage: level },
      signed: true,
    });
  }

  async getFundingRate(contract: string) {
    const symbol = toSymbol(contract);
    const data = await this.request<any[]>({
      path: "/fapi/v1/fundingRate",
      params: { symbol, limit: 1 },
    });
    return data[0] ?? null;
  }

  async getContractInfo(contract: string) {
    const meta = await this.getSymbolMeta(contract);
    const minContracts = Math.max(1, Math.round(meta.minQty / meta.stepSize));
    const maxContracts = Math.max(minContracts, Math.floor(meta.maxQty / meta.stepSize));
    return {
      name: contract.toUpperCase(),
      quantoMultiplier: meta.stepSize,
      orderSizeMin: minContracts.toString(),
      orderSizeMax: maxContracts.toString(),
      orderSizeStep: "1",
      minNotional: meta.minNotional,
      maxLeverage: meta.maxLeverage,
      baseAsset: meta.baseAsset,
      priceTickSize: meta.tickSize,
    };
  }

  async getAllContracts() {
    const info = await this.getExchangeInfo();
    return info.symbols
      ?.filter(
        (symbol: any) =>
          symbol.contractType === "PERPETUAL" && symbol.quoteAsset === "USDT",
      )
      .map((symbol: any) => {
        const lotSizeFilter =
          symbol.filters?.find(
            (filter: any) => filter.filterType === "LOT_SIZE",
          ) ?? {};
        const stepSize = Number.parseFloat(lotSizeFilter.stepSize ?? "0.001");
        const minQty = Number.parseFloat(
          lotSizeFilter.minQty ?? stepSize.toString(),
        );
        const maxQty = Number.parseFloat(lotSizeFilter.maxQty ?? "1000000");
        const minContracts = Math.max(1, Math.round(minQty / stepSize));
        const maxContracts = Math.max(
          minContracts,
          Math.floor(maxQty / stepSize),
        );

        return {
          name: toContract(symbol.symbol),
          baseAsset: symbol.baseAsset,
          quoteAsset: symbol.quoteAsset,
          contractType: symbol.contractType,
          leverage_min: 1,
          leverage_max: symbol.maxLeverage ?? "125",
          order_size_min: minContracts.toString(),
          order_size_max: maxContracts.toString(),
          order_size_round: lotSizeFilter.stepSize ?? "0.001",
          order_price_round:
            symbol.filters?.find(
              (filter: any) => filter.filterType === "PRICE_FILTER",
            )?.tickSize ?? "0.1",
          in_delisting: symbol.status !== "TRADING",
        };
      });
  }

  async getOrderBook(contract: string, limit: number = 10) {
    const symbol = toSymbol(contract);
    const data = await this.request<any>({
      path: "/fapi/v1/depth",
      params: { symbol, limit },
    });
    const normalizeSide = (entries: any[] = []) =>
      entries.slice(0, limit).map((entry: any) => {
        const [price, qty] = Array.isArray(entry) ? entry : [entry.p, entry.s];
        const numericPrice = Number.parseFloat(price ?? "0");
        const numericSize = Number.parseFloat(qty ?? "0");
        return {
          price: numericPrice,
          size: numericSize,
          p: price ?? numericPrice.toString(),
          s: qty ?? numericSize.toString(),
        };
      });

    return {
      bids: normalizeSide(data.bids),
      asks: normalizeSide(data.asks),
      lastUpdateId: data.lastUpdateId,
    };
  }

  async getMyTrades(contract?: string, limit: number = 10) {
    if (!contract) {
      throw new Error("Binance getMyTrades 需要指定合约名称");
    }
    const symbol = toSymbol(contract);
    return this.request<any[]>({
      path: "/fapi/v1/userTrades",
      params: { symbol, limit },
      signed: true,
    });
  }

  async getPositionHistory(
    contract?: string,
    limit: number = 100,
    offset: number = 0,
  ) {
    const params: Record<string, string | number> = {
      limit,
      incomeType: "REALIZED_PNL",
    };
    if (contract) {
      params.symbol = toSymbol(contract);
    }
    if (offset > 0) {
      params.startTime = Date.now() - offset * 1000;
    }
    return this.request<any[]>({
      path: "/fapi/v1/income",
      params,
      signed: true,
    });
  }

  async getSettlementHistory(
    contract?: string,
    limit: number = 100,
    offset: number = 0,
  ) {
    const params: Record<string, string | number> = {
      limit,
      incomeType: "FUNDING_FEE",
    };
    if (contract) {
      params.symbol = toSymbol(contract);
    }
    if (offset > 0) {
      params.startTime = Date.now() - offset * 1000;
    }
    return this.request<any[]>({
      path: "/fapi/v1/income",
      params,
      signed: true,
    });
  }

  async getOrderHistory(contract?: string, limit: number = 10) {
    const symbols = contract
      ? [toSymbol(contract)]
      : RISK_PARAMS.TRADING_SYMBOLS.map((symbol) =>
          toSymbol(`${symbol}_USDT`),
        );

    const results: NormalizedOrder[] = [];
    for (const symbol of symbols) {
      try {
        const meta = await this.getSymbolMeta(toContract(symbol));
        const data = await this.request<any[]>({
          path: "/fapi/v1/allOrders",
          params: { symbol, limit },
          signed: true,
        });
        data.forEach((order: any) => results.push(this.normalizeOrder(order, meta)));
      } catch (error: any) {
        logger.warn(`获取 ${symbol} 历史订单失败: ${error.message}`);
      }
    }
    return results.slice(0, limit);
  }
}

let binanceClientInstance: BinanceExchangeClient | null = null;

export function createBinanceExchangeClient(): BinanceExchangeClient {
  if (binanceClientInstance) {
    return binanceClientInstance;
  }

  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error("使用 Binance 交易所需要设置 BINANCE_API_KEY 和 BINANCE_API_SECRET");
  }

  binanceClientInstance = new BinanceExchangeClient(apiKey, apiSecret);
  return binanceClientInstance;
}
