import { randomUUID } from "node:crypto";
import { createPinoLogger } from "@voltagent/logger";
import { createBinanceExchangeClient } from "./binanceExchangeClient";
import type { ExchangeClient, ExchangeOrderParams } from "./types";

interface DryRunConfig {
  initialBalance: number;
  feeBps: number;
  slippageBps: number;
  maintenanceBuffer: number;
}

interface DryRunPosition {
  contract: string;
  size: number; // 正为多单张数，负为空单张数
  entryPrice: number;
  leverage: number;
  margin: number;
  reservedMargin: number;
  openedAt: string;
  updatedAt: string;
  realisedPnl: number;
  peakPnl: number;
}

interface DryRunOrder {
  id: string;
  clientOrderId: string;
  contract: string;
  size: number;
  filledQuantity: number;
  price: number;
  status: "filled" | "cancelled";
  reduceOnly: boolean;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  tif: string;
  updateTime: string;
}

interface DryRunTrade {
  id: string;
  orderId: string;
  contract: string;
  price: number;
  quantity: number;
  side: "BUY" | "SELL";
  realisedPnl: number;
  fee: number;
  timestamp: string;
}

const logger = createPinoLogger({
  name: "binance-dry-run",
  level: (process.env.LOG_LEVEL as any) || "info",
});

function loadConfig(): DryRunConfig {
  const initialBalance = Number.parseFloat(
    process.env.DRY_RUN_INITIAL_BALANCE || "1000",
  );
  const feeBps = Number.parseFloat(process.env.DRY_RUN_FEE_BPS || "5"); // 0.05%
  const slippageBps = Number.parseFloat(process.env.DRY_RUN_SLIPPAGE_BPS || "10"); // 0.10%
  const maintenanceBuffer = Number.parseFloat(
    process.env.DRY_RUN_MARGIN_BUFFER_BPS || "50",
  ); // 0.5%

  return {
    initialBalance: Number.isFinite(initialBalance) && initialBalance > 0
      ? initialBalance
      : 1000,
    feeBps: Number.isFinite(feeBps) && feeBps >= 0 ? feeBps : 5,
    slippageBps: Number.isFinite(slippageBps) && slippageBps >= 0
      ? slippageBps
      : 10,
    maintenanceBuffer: Number.isFinite(maintenanceBuffer) && maintenanceBuffer >= 0
      ? maintenanceBuffer
      : 50,
  };
}

export function createBinanceDryRunExchangeClient(): ExchangeClient {
  const config = loadConfig();
  const marketClient = createBinanceExchangeClient();

  let walletBalance = config.initialBalance;
  const positions = new Map<string, DryRunPosition>();
  const contractLeverage = new Map<string, number>();
  const orders = new Map<string, DryRunOrder>();
  const trades: DryRunTrade[] = [];

  logger.info(
    `Binance Dry-Run 模式已启用：初始资金 ${walletBalance.toFixed(2)} USDT，手续费 ${(
      config.feeBps / 10000
    ).toFixed(4)}，滑点 ${(
      config.slippageBps / 10000
    ).toFixed(4)}, 保证金缓冲 ${(
      config.maintenanceBuffer / 10000
    ).toFixed(4)}.`,
  );

  function getLeverage(contract: string): number {
    return contractLeverage.get(contract) ?? 10;
  }

  async function computeUnrealisedPnl(position: DryRunPosition): Promise<{
    unrealised: number;
    markPrice: number;
  }> {
      const ticker = await marketClient.getFuturesTicker(position.contract);
      const markPrice = Number.parseFloat(ticker.last || ticker.markPrice || "0");
      const quantity = Math.abs(position.size);
      const entry = position.entryPrice;
      const direction = position.size >= 0 ? 1 : -1;
      const priceDiff = markPrice - entry;
    const meta = await marketClient.getContractInfo(position.contract);
    const multiplier = Number(meta?.quantoMultiplier ?? 1);
      const unrealised = priceDiff * direction * quantity * multiplier;

      return {
        unrealised,
        markPrice,
      };
  }

  function createOrderRecord(params: {
    contract: string;
    size: number;
    price: number;
    reduceOnly?: boolean;
  }): DryRunOrder {
    const id = Date.now().toString();
    const order: DryRunOrder = {
      id,
      clientOrderId: randomUUID().replace(/-/g, "").slice(0, 24),
      contract: params.contract,
      size: params.size,
      filledQuantity: Math.abs(params.size),
      price: params.price,
      status: "filled",
      reduceOnly: Boolean(params.reduceOnly),
      side: params.size >= 0 ? "BUY" : "SELL",
      type: "MARKET",
      tif: "gtc",
      updateTime: new Date().toISOString(),
    };
    orders.set(id, order);
    return order;
  }

  async function updatePositionAfterTrade(
    contract: string,
    fillSize: number,
    fillPrice: number,
    leverage: number,
    fee: number,
  ): Promise<{ position?: DryRunPosition; realisedPnl: number }> {
    const meta = await marketClient.getContractInfo(contract);
    const multiplier = Number(meta?.quantoMultiplier ?? 1);
    const timeNow = new Date().toISOString();
    const direction = fillSize >= 0 ? 1 : -1;
    const absFill = Math.abs(fillSize);
      const notional = absFill * fillPrice * multiplier;
      const requiredMargin = notional / Math.max(1, leverage);
      const bufferRatio = config.maintenanceBuffer / 10000;
      const requiredWithBuffer = requiredMargin * (1 + bufferRatio);

    const existing = positions.get(contract);

      if (!existing || existing.size === 0) {
        if (walletBalance < requiredWithBuffer + fee) {
          throw new Error(
            `Dry-Run: Margin is insufficient (需要 ${requiredWithBuffer.toFixed(
              2,
            )} + 手续费 ${fee.toFixed(2)} USDT，可用 ${walletBalance.toFixed(2)} USDT)`,
          );
        }

        walletBalance -= requiredWithBuffer + fee;
        const position: DryRunPosition = {
          contract,
          size: fillSize,
          entryPrice: fillPrice,
          leverage,
          margin: requiredMargin,
          reservedMargin: requiredWithBuffer,
          openedAt: timeNow,
          updatedAt: timeNow,
          realisedPnl: 0,
          peakPnl: 0,
        };
        positions.set(contract, position);
        return { position, realisedPnl: 0 };
      }

    const existingSize = existing.size;
    const sameDirection = Math.sign(existingSize) === direction;
    let realisedPnl = 0;

    if (sameDirection) {
      const totalAbs = Math.abs(existingSize) + absFill;
      const avgPrice = (
        Math.abs(existingSize) * existing.entryPrice + absFill * fillPrice
      ) / totalAbs;
      const newMargin = (totalAbs * avgPrice * multiplier) / Math.max(1, leverage);
      const newReserved = newMargin * (1 + bufferRatio);
      const marginDelta = newReserved - existing.reservedMargin;

      if (walletBalance < marginDelta + fee) {
        throw new Error(
          `Dry-Run: Margin is insufficient (需要追加 ${marginDelta.toFixed(
            2,
          )} + 手续费 ${fee.toFixed(2)} USDT，可用 ${walletBalance.toFixed(2)} USDT)`,
        );
      }

      walletBalance -= marginDelta + fee;
      existing.size += fillSize;
      existing.entryPrice = avgPrice;
      existing.margin = newMargin;
      existing.reservedMargin = newReserved;
      existing.updatedAt = timeNow;
      existing.realisedPnl -= fee;
      positions.set(contract, existing);
      return { position: existing, realisedPnl: -fee };
    }

    const closingSize = Math.min(Math.abs(existingSize), absFill);
    const remainingSize = existingSize + fillSize;
    const closingRatio = closingSize / Math.abs(existingSize);
    const pnlDirection = existingSize >= 0 ? 1 : -1;
    const priceDiff = fillPrice - existing.entryPrice;
    const pnl = priceDiff * pnlDirection * closingSize * multiplier;
    const releasedReserved = existing.reservedMargin * closingRatio;

    walletBalance += releasedReserved;
    realisedPnl += pnl - fee;
    walletBalance += realisedPnl;

    if (remainingSize === 0) {
      positions.delete(contract);
      return { realisedPnl, position: undefined };
    }

    const remainingSign = Math.sign(remainingSize);
    const existingSign = Math.sign(existingSize);

    if (remainingSign === existingSign) {
      existing.size = remainingSize;
      existing.margin = existing.margin - existing.margin * closingRatio;
      existing.reservedMargin =
        existing.reservedMargin - existing.reservedMargin * closingRatio;
      existing.updatedAt = timeNow;
      existing.realisedPnl += realisedPnl;
      positions.set(contract, existing);
      return { position: existing, realisedPnl };
    }

    const newAbs = Math.abs(remainingSize);
    const newMargin =
      (newAbs * fillPrice * multiplier) / Math.max(1, leverage);
    const newReserved = newMargin * (1 + bufferRatio);

    if (walletBalance < newReserved) {
      throw new Error(
        `Dry-Run: Margin is insufficient (新仓位需要 ${newReserved.toFixed(
          2,
        )} USDT，可用 ${walletBalance.toFixed(2)} USDT)`,
      );
    }

    walletBalance -= newReserved;

    const newPosition: DryRunPosition = {
      contract,
      size: remainingSize,
      entryPrice: fillPrice,
      leverage,
      margin: newMargin,
      reservedMargin: newReserved,
      openedAt: timeNow,
      updatedAt: timeNow,
      realisedPnl: 0,
      peakPnl: 0,
    };
    positions.set(contract, newPosition);
    return { position: newPosition, realisedPnl };
  }

  return {
    async getFuturesTicker(contract) {
      return marketClient.getFuturesTicker(contract);
    },
    async getFuturesCandles(contract, interval, limit) {
      return marketClient.getFuturesCandles(contract, interval, limit);
    },
    async getFuturesAccount() {
      let unrealised = 0;
      let reservedTotal = 0;

      for (const position of positions.values()) {
        const { unrealised: pnlEstimate } = await computeUnrealisedPnl(position);
        unrealised += pnlEstimate;
        reservedTotal += position.reservedMargin;
      }

      const totalEquity = walletBalance + reservedTotal + unrealised;
      return {
        total: totalEquity.toFixed(8),
        available: walletBalance.toFixed(8),
        unrealisedPnl: unrealised.toFixed(8),
        marginBalance: (walletBalance + reservedTotal).toFixed(8),
        assets: [
          {
            asset: "USDT",
            walletBalance: totalEquity.toFixed(8),
            available: walletBalance.toFixed(8),
          },
        ],
      };
    },
    async getPositions() {
      const result = [];
      for (const position of positions.values()) {
        const { unrealised, markPrice } = await computeUnrealisedPnl(position);
        result.push({
          contract: position.contract,
          symbol: position.contract,
          size: position.size.toString(),
          leverage: position.leverage.toString(),
          entryPrice: position.entryPrice.toString(),
          markPrice: markPrice.toString(),
          margin: position.margin.toString(),
          unRealizedProfit: unrealised.toString(),
          unrealisedPnl: unrealised.toString(),
          realisedPnl: position.realisedPnl.toString(),
          side: position.size >= 0 ? "long" : "short",
          updateTime: position.updatedAt,
          createTime: position.openedAt,
        });
      }
      return result;
    },
    async placeOrder(params: ExchangeOrderParams) {
      const contract = params.contract;
      const leverage = getLeverage(contract);
      const ticker = await marketClient.getFuturesTicker(contract);
      const lastPrice = Number.parseFloat(ticker.last || ticker.markPrice || "0");
      if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
        throw new Error(`Dry-Run: 无法获取 ${contract} 的最新价格`);
      }

      const slippageRatio = config.slippageBps / 10000;
      const slipMultiplier = params.size >= 0 ? 1 : -1;
      const fillPrice = lastPrice * (1 + slippageRatio * slipMultiplier);
      const feeRatio = config.feeBps / 10000;
      const absSize = Math.abs(params.size);
      const meta = await marketClient.getContractInfo(contract);
    const multiplier = Number(meta?.quantoMultiplier ?? 1);
      const notional = absSize * fillPrice * multiplier;
      const fee = notional * feeRatio;

      const { realisedPnl } = await updatePositionAfterTrade(
        contract,
        params.size,
        fillPrice,
        leverage,
        fee,
      );

      const order = createOrderRecord({
        contract,
        size: params.size,
        price: fillPrice,
        reduceOnly: params.reduceOnly,
      });

      trades.push({
        id: randomUUID(),
        orderId: order.id,
        contract,
        price: fillPrice,
        quantity: absSize,
        side: order.side,
        realisedPnl,
        fee,
        timestamp: order.updateTime,
      });

      return {
        id: order.id,
        contract: order.contract,
        size: order.size.toString(),
        left: "0",
        price: order.price.toString(),
        status: order.status,
        tif: order.tif,
        avgFillPrice: order.price.toString(),
        reduceOnly: order.reduceOnly,
        side: order.side,
        type: order.type,
        clientOrderId: order.clientOrderId,
        updateTime: order.updateTime,
      };
    },
    async getOrder(orderId: string) {
      const record = orders.get(orderId);
      if (!record) {
        throw new Error(`Dry-Run: 未找到订单 ${orderId}`);
      }
      return {
        id: record.id,
        contract: record.contract,
        size: record.size.toString(),
        left: "0",
        price: record.price.toString(),
        status: record.status,
        tif: record.tif,
        avgFillPrice: record.price.toString(),
        reduceOnly: record.reduceOnly,
        side: record.side,
        type: record.type,
        clientOrderId: record.clientOrderId,
        updateTime: record.updateTime,
      };
    },
    async cancelOrder(orderId: string) {
      const record = orders.get(orderId);
      if (!record) {
        throw new Error(`Dry-Run: 未找到订单 ${orderId}`);
      }
      record.status = "cancelled";
      record.updateTime = new Date().toISOString();
      orders.set(orderId, record);
      return record;
    },
    async getOpenOrders(contract?: string) {
      const values = Array.from(orders.values()).filter(
        (order) => order.status !== "filled",
      );
      if (contract) {
        return values.filter((order) => order.contract === contract);
      }
      return values;
    },
    async setLeverage(contract: string, leverage: number) {
      contractLeverage.set(contract, Math.max(1, Math.floor(leverage)));
      return { symbol: contract, leverage };
    },
    async getFundingRate(contract: string) {
      return marketClient.getFundingRate(contract);
    },
    async getContractInfo(contract: string) {
      return marketClient.getContractInfo(contract);
    },
    async getAllContracts() {
      return marketClient.getAllContracts();
    },
    async getOrderBook(contract, limit) {
      return marketClient.getOrderBook(contract, limit);
    },
    async getMyTrades(contract?: string) {
      if (!contract) return trades;
      return trades.filter((trade) => trade.contract === contract);
    },
    async getPositionHistory(contract?: string) {
      const history = trades.map((trade) => ({
        contract: trade.contract,
        price: trade.price,
        quantity: trade.quantity,
        side: trade.side,
        realisedPnl: trade.realisedPnl,
        timestamp: trade.timestamp,
      }));
      if (!contract) return history;
      return history.filter((item) => item.contract === contract);
    },
    async getSettlementHistory() {
      return [];
    },
    async getOrderHistory(contract?: string) {
      const list = Array.from(orders.values());
      if (!contract) return list;
      return list.filter((order) => order.contract === contract);
    },
  };
}
