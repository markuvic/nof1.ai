import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  promises as fsPromises,
} from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
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

interface DryRunSnapshot {
  version: number;
  timestamp: string;
  walletBalance: number;
  positions: DryRunPosition[];
  orders: DryRunOrder[];
  trades: DryRunTrade[];
  contractLeverage: Array<{ contract: string; leverage: number }>;
  config: DryRunConfig;
}

const SNAPSHOT_VERSION = 1;
const DEFAULT_SNAPSHOT_FILE = ".voltagent/dry-run-state.json";
let exitHandlerRegistered = false;

const logger = createPinoLogger({
  name: "binance-dry-run",
  level: (process.env.LOG_LEVEL as any) || "info",
});

function resolveSnapshotPath(): string {
  const custom = process.env.DRY_RUN_STATE_PATH?.trim();
  if (custom && custom.length > 0) {
    return resolvePath(process.cwd(), custom);
  }
  return resolvePath(process.cwd(), DEFAULT_SNAPSHOT_FILE);
}

function loadSnapshotFromDisk(path: string): DryRunSnapshot | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as DryRunSnapshot;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (parsed.version !== SNAPSHOT_VERSION) {
      logger.warn(
        `检测到不兼容的 dry-run 快照版本: ${parsed.version}，当前版本 ${SNAPSHOT_VERSION}，将忽略旧数据。`,
      );
      return null;
    }
    return parsed;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return null;
    }
    logger.error("读取 dry-run 快照失败:", error);
    return null;
  }
}

function registerDryRunExitHandlers(flush: () => void) {
  if (exitHandlerRegistered) {
    return;
  }
  exitHandlerRegistered = true;
  let flushed = false;
  const safeFlush = () => {
    if (flushed) return;
    flushed = true;
    try {
      flush();
    } catch (error) {
      logger.error("退出前写入 dry-run 快照失败:", error as any);
    }
  };
  process.once("beforeExit", safeFlush);
  process.once("exit", safeFlush);
}

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

  const snapshotPath = resolveSnapshotPath();
  const snapshotDir = dirname(snapshotPath);
  const shouldResetSnapshot =
    process.env.DRY_RUN_RESET === "true" || process.env.DRY_RUN_CLEAR === "true";

  if (shouldResetSnapshot && existsSync(snapshotPath)) {
    try {
      unlinkSync(snapshotPath);
      logger.info("检测到 DRY_RUN_RESET，已清空 dry-run 状态快照。");
    } catch (error) {
      logger.warn("尝试清空 dry-run 快照失败:", error as any);
    }
  }

  let walletBalance = config.initialBalance;
  const positions = new Map<string, DryRunPosition>();
  const contractLeverage = new Map<string, number>();
  const orders = new Map<string, DryRunOrder>();
  const trades: DryRunTrade[] = [];

  let persistTimer: NodeJS.Timeout | null = null;
  let persistInFlight: Promise<void> | null = null;

  function buildSnapshot(): DryRunSnapshot {
    return {
      version: SNAPSHOT_VERSION,
      timestamp: new Date().toISOString(),
      walletBalance,
      positions: Array.from(positions.values()),
      orders: Array.from(orders.values()),
      trades: [...trades],
      contractLeverage: Array.from(contractLeverage.entries()).map(
        ([contract, leverage]) => ({ contract, leverage }),
      ),
      config,
    };
  }

  async function persistSnapshot() {
    try {
      const snapshot = buildSnapshot();
      await fsPromises.mkdir(snapshotDir, { recursive: true });
      const tempPath = `${snapshotPath}.tmp`;
      await fsPromises.writeFile(
        tempPath,
        JSON.stringify(snapshot, null, 2),
        "utf8",
      );
      try {
        await fsPromises.rename(tempPath, snapshotPath);
      } catch (renameError: any) {
        if (
          renameError?.code === "EEXIST" ||
          renameError?.code === "EPERM" ||
          renameError?.code === "EXDEV"
        ) {
          await fsPromises.rm(snapshotPath, { force: true }).catch(() => {});
          await fsPromises.rename(tempPath, snapshotPath);
        } else {
          throw renameError;
        }
      }
    } catch (error) {
      logger.error("保存 dry-run 快照失败:", error as any);
    }
  }

  function schedulePersist() {
    if (persistTimer) {
      clearTimeout(persistTimer);
    }
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const run = (async () => {
        if (persistInFlight) {
          try {
            await persistInFlight;
          } catch {
            // 已在先前持久化阶段记录错误
          }
        }
        await persistSnapshot();
      })();
      persistInFlight = run;
      run.finally(() => {
        if (persistInFlight === run) {
          persistInFlight = null;
        }
      }).catch(() => {
        // 错误已在 persistSnapshot 内部处理
      });
    }, 200);
  }

  function flushSnapshotSync() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (persistInFlight) {
      // best-effort: allow async write to finish before fallback
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      persistInFlight.catch(() => {
        // ignore errors here, will attempt sync write below
      });
    }
    try {
      const snapshot = buildSnapshot();
      mkdirSync(snapshotDir, { recursive: true });
      writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
    } catch (error) {
      logger.error("同步写入 dry-run 快照失败:", error as any);
    }
  }

  registerDryRunExitHandlers(flushSnapshotSync);

  const snapshot = shouldResetSnapshot
    ? null
    : loadSnapshotFromDisk(snapshotPath);

  if (snapshot) {
    walletBalance = Number.isFinite(snapshot.walletBalance)
      ? snapshot.walletBalance
      : config.initialBalance;
    positions.clear();
    snapshot.positions?.forEach((position) => {
      if (position?.contract) {
        positions.set(position.contract, { ...position });
      }
    });
    contractLeverage.clear();
    snapshot.contractLeverage?.forEach(({ contract, leverage }) => {
      if (contract) {
        contractLeverage.set(contract, Math.max(1, Math.floor(leverage)));
      }
    });
    orders.clear();
    snapshot.orders?.forEach((order) => {
      if (order?.id) {
        orders.set(order.id, { ...order });
      }
    });
    trades.length = 0;
    if (Array.isArray(snapshot.trades)) {
      trades.push(
        ...snapshot.trades.map((trade) => ({
          ...trade,
        })),
      );
    }
    logger.info(
      `Dry-Run 状态已从快照恢复：余额 ${walletBalance.toFixed(
        2,
      )} USDT，持仓 ${positions.size} 个，历史成交 ${trades.length} 条。`,
    );
  } else {
    schedulePersist();
  }

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
    schedulePersist();
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
        schedulePersist();
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
      schedulePersist();
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
      schedulePersist();
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
      schedulePersist();
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
    schedulePersist();
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
      schedulePersist();

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
      schedulePersist();
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
      schedulePersist();
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
