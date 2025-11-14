/**
 * open-nof1.ai - AI 加密货币自动交易系统
 * Copyright (C) 2025 195440
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 * 
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * API 路由
 */
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { createClient } from "@libsql/client";
import { createExchangeClient } from "../services/exchanges";
import { normalizeAccountSnapshot } from "../services/accountMetrics";
import { createPinoLogger } from "@voltagent/logger";
import { getCachedQuantReports } from "../services/quantReport";
import { getTraderIdentity } from "../config/traderProfile";
import { getTradingLoopConfig } from "../config/tradingLoop";
import { getTradingLoopRuntimeInfo } from "../scheduler/tradingLoop";

const logger = createPinoLogger({
  name: "api-routes",
  level: "info",
});

const dbClient = createClient({
  url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
});

const serverStartedAt = new Date();
const tradingLoopConfig = getTradingLoopConfig();

export function createApiRoutes() {
  const app = new Hono();

  // 静态文件服务 - 需要使用绝对路径
  app.use("/*", serveStatic({ root: "./public" }));

  /**
   * 交易员元数据
   */
  app.get("/api/trader/meta", (c) => {
    const identity = getTraderIdentity();
    const uptimeSeconds = Math.floor((Date.now() - serverStartedAt.getTime()) / 1000);
    return c.json({
      ...identity,
      version: process.env.npm_package_version ?? "0.0.0",
      uptimeSeconds,
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * 获取账户总览
   * 
   * Gate.io 账户结构：
   * - account.total = available + positionMargin
   * - account.total 不包含未实现盈亏
   * - 真实总资产 = account.total + unrealisedPnl
   * 
   * API返回说明：
   * - totalBalance: 不包含未实现盈亏的总资产（用于计算已实现收益）
   * - unrealisedPnl: 当前持仓的未实现盈亏
   * 
   * 前端显示：
   * - 总资产显示 = totalBalance + unrealisedPnl（实时反映持仓盈亏）
   */
  app.get("/api/account", async (c) => {
    try {
      const exchangeClient = createExchangeClient();
      const account = await exchangeClient.getFuturesAccount();
      const snapshot = normalizeAccountSnapshot(account);
      
      // 从数据库获取初始资金
      const initialResult = await dbClient.execute(
        "SELECT total_value, timestamp FROM account_history ORDER BY timestamp ASC LIMIT 1"
      );
      const initialRow = initialResult.rows[0] as { total_value?: string; timestamp?: string } | undefined;
      const initialBalance = initialRow?.total_value
        ? Number.parseFloat(initialRow.total_value)
        : 100;
      const accountStartAt = initialRow?.timestamp ?? null;
      
      // Gate.io 的 account.total 不包含未实现盈亏
      // 总资产（不含未实现盈亏）= account.total
      const unrealisedPnl = snapshot.unrealisedPnl;
      const totalBalance = snapshot.realizedBalance;
      const totalEquity = snapshot.equity;
      
      // 收益率 = (权益 - 初始资金) / 初始资金 * 100
      const returnPercent = initialBalance > 0
        ? ((totalEquity - initialBalance) / initialBalance) * 100
        : 0;
      
      const { traderName } = getTraderIdentity();
      const loopRuntime = getTradingLoopRuntimeInfo();
      const tradingIntervalMinutes =
        loopRuntime.activeIntervalMinutes || tradingLoopConfig.defaultIntervalMinutes;

      return c.json({
        traderName,
        totalBalance,  // 总资产（不包含未实现盈亏）
        availableBalance: snapshot.availableBalance,
        positionMargin: snapshot.positionMargin,
        unrealisedPnl,
        returnPercent,  // 收益率（不包含未实现盈亏）
        initialBalance,
        accountStartAt,
        tradingIntervalMinutes,
        llmLoopControlEnabled: loopRuntime.llmControlEnabled,
        nextTradingRunAt: loopRuntime.llmControlEnabled
          ? loopRuntime.nextRunAt
          : undefined,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  /**
   * 获取当前持仓 - 从 Gate.io 获取实时数据
   */
  app.get("/api/positions", async (c) => {
    try {
      const exchangeClient = createExchangeClient();
      const gatePositions = await exchangeClient.getPositions();
      
      // 从数据库获取止损止盈信息
      const dbResult = await dbClient.execute("SELECT symbol, stop_loss, profit_target FROM positions");
      const dbPositionsMap = new Map(
        dbResult.rows.map((row: any) => [row.symbol, row])
      );
      
      const toNumber = (value: unknown, fallback = 0) => {
        if (value === null || value === undefined) {
          return fallback;
        }
        if (typeof value === "number") {
          return Number.isFinite(value) ? value : fallback;
        }
        if (typeof value === "string" && value.trim().length > 0) {
          const parsed = Number.parseFloat(value);
          return Number.isFinite(parsed) ? parsed : fallback;
        }
        return fallback;
      };

      const normalizeContract = (raw: unknown): string | null => {
        if (typeof raw !== "string" || raw.trim().length === 0) {
          return null;
        }
        const upper = raw.trim().toUpperCase();
        if (upper.includes("_")) {
          return upper;
        }
        if (upper.endsWith("USDT")) {
          return `${upper.slice(0, -4)}_USDT`;
        }
        return `${upper}_USDT`;
      };

      const positions: Array<{
        symbol: string;
        quantity: number;
        entryPrice: number;
        currentPrice: number;
        liquidationPrice: number;
        unrealizedPnl: number;
        leverage: number;
        side: "long" | "short";
        openValue: number;
        profitTarget: number | null;
        stopLoss: number | null;
        openedAt: string;
      }> = [];

      for (const position of gatePositions ?? []) {
        const rawSize = toNumber(
          (position as any).positionAmt ?? (position as any).size,
        );
        if (!Number.isFinite(rawSize) || Math.abs(rawSize) <= 0) {
          continue;
        }

        const contractName =
          normalizeContract((position as any).contract) ??
          normalizeContract((position as any).symbol);
        if (!contractName) {
          logger.warn(
            `跳过无法识别合约的持仓: ${JSON.stringify(position).slice(0, 200)}`,
          );
          continue;
        }

        const symbol = contractName.replace("_USDT", "");
        const dbPos = dbPositionsMap.get(symbol);
        const entryPrice = toNumber((position as any).entryPrice);
        const currentPrice = toNumber((position as any).markPrice);
        const leverage = Math.max(1, toNumber((position as any).leverage, 1));
        const quantity = Math.abs(rawSize);
        const unrealized =
          toNumber((position as any).unrealisedPnl) ??
          toNumber((position as any).unRealizedProfit) ??
          0;

        const reportedMargin = toNumber((position as any).margin);
        const reportedNotional = toNumber((position as any).notional);

        let openValue = reportedMargin > 0 ? reportedMargin : 0;
        if (!(openValue > 0)) {
          const derivedNotional =
            reportedNotional > 0
              ? reportedNotional
              : entryPrice > 0 && quantity > 0
              ? quantity * entryPrice
              : 0;
          if (derivedNotional > 0) {
            openValue = leverage > 0 ? derivedNotional / leverage : derivedNotional;
          }
        }
        if (!Number.isFinite(openValue)) {
          openValue = 0;
        }

        positions.push({
          symbol,
          quantity,
          entryPrice,
          currentPrice,
          liquidationPrice: toNumber((position as any).liqPrice),
          unrealizedPnl: unrealized,
          leverage,
          side: rawSize > 0 ? "long" : "short",
          openValue,
          profitTarget: dbPos?.profit_target ? Number(dbPos.profit_target) : null,
          stopLoss: dbPos?.stop_loss ? Number(dbPos.stop_loss) : null,
          openedAt:
            (position as any).create_time ||
            (position as any).update_time ||
            new Date().toISOString(),
        });
      }
      
      return c.json({ positions });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  /**
   * 获取账户价值历史（用于绘图）
   */
  app.get("/api/history", async (c) => {
    try {
      const limitParam = c.req.query("limit");
      const exchangeClient = createExchangeClient();
      
      let result;
      if (limitParam) {
        // 如果传递了 limit 参数，使用 LIMIT 子句
        const limit = Number.parseInt(limitParam);
        result = await dbClient.execute({
          sql: `SELECT timestamp, total_value, unrealized_pnl, return_percent 
                FROM account_history 
                ORDER BY timestamp DESC 
                LIMIT ?`,
          args: [limit],
        });
      } else {
        // 如果没有传递 limit 参数，返回全部数据
        result = await dbClient.execute(
          `SELECT timestamp, total_value, unrealized_pnl, return_percent 
           FROM account_history 
           ORDER BY timestamp DESC`
        );
      }
      
      let history = result.rows.map((row: any) => ({
        timestamp: row.timestamp,
        totalValue: Number.parseFloat(row.total_value as string) || 0,
        unrealizedPnl: Number.parseFloat(row.unrealized_pnl as string) || 0,
        returnPercent: Number.parseFloat(row.return_percent as string) || 0,
      })).reverse(); // 反转，使时间从旧到新

      // 补充当前最新权益快照，避免曲线在 dry-run 模式中长时间停留在初始值
      try {
        const liveAccount = await exchangeClient.getFuturesAccount();
        const liveSnapshot = normalizeAccountSnapshot(liveAccount);
        const currentEquity = liveSnapshot.equity;
        const currentUnrealised = liveSnapshot.unrealisedPnl;
        const lastPoint = history.at(-1);
        const nowIso = new Date().toISOString();
        const initialBase = history.length > 0 ? history[0].totalValue : currentEquity;
        const liveReturnPercent = initialBase > 0
          ? ((currentEquity - initialBase) / initialBase) * 100
          : 0;

        const hasRecentPoint = lastPoint
          ? Math.abs(lastPoint.totalValue - currentEquity) < 1e-4
          && Math.abs(currentUnrealised - lastPoint.unrealizedPnl) < 1e-4
          : false;

        if (!hasRecentPoint) {
          history = [...history, {
            timestamp: nowIso,
            totalValue: currentEquity,
            unrealizedPnl: currentUnrealised,
            returnPercent: liveReturnPercent,
          }];
        }
      } catch (error) {
        logger.warn("获取当前账户权益失败，使用历史数据展示:", error as any);
      }
      
      return c.json({ history });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  /**
   * 获取交易记录 - 从数据库获取历史仓位（已平仓的记录）
   */
  app.get("/api/trades", async (c) => {
    try {
      const limit = Number.parseInt(c.req.query("limit") || "10");
      const symbol = c.req.query("symbol"); // 可选，筛选特定币种
      
      // 从数据库获取历史交易记录（忽略系统风控占位记录）
      const tradeWhere: string[] = ["status != 'system-close'"];
      const tradeArgs: any[] = [];
      if (symbol) {
        tradeWhere.push("symbol = ?");
        tradeArgs.push(symbol);
      }

      const tradeWhereClause = tradeWhere.length > 0 ? `WHERE ${tradeWhere.join(" AND ")}` : "";
      const sql = `SELECT * FROM trades ${tradeWhereClause} ORDER BY timestamp DESC LIMIT ?`;
      const args = [...tradeArgs, limit];
      
      const result = await dbClient.execute({
        sql,
        args,
      });
      
      if (!result.rows || result.rows.length === 0) {
        return c.json({ trades: [] });
      }
      
      // 转换数据库格式到前端需要的格式
      const trades = result.rows.map((row: any) => {
        return {
          id: row.id,
          orderId: row.order_id,
          symbol: row.symbol,
          side: row.side, // long/short
          type: row.type, // open/close
          price: Number.parseFloat(row.price || "0"),
          quantity: Number.parseFloat(row.quantity || "0"),
          leverage: Number.parseInt(row.leverage || "1"),
          pnl: row.pnl ? Number.parseFloat(row.pnl) : null,
          fee: Number.parseFloat(row.fee || "0"),
          timestamp: row.timestamp,
          status: row.status,
        };
      });
      
      return c.json({ trades });
    } catch (error: any) {
      logger.error("获取历史仓位失败:", error);
      return c.json({ error: error.message }, 500);
    }
  });

  /**
   * 获取 Agent 决策日志
   */
  app.get("/api/logs", async (c) => {
    try {
      const limit = c.req.query("limit") || "20";
      
      const result = await dbClient.execute({
        sql: `SELECT * FROM agent_decisions 
              ORDER BY timestamp DESC 
              LIMIT ?`,
        args: [Number.parseInt(limit)],
      });
      
      const logs = result.rows.map((row: any) => ({
        id: row.id,
        timestamp: row.timestamp,
        iteration: row.iteration,
        decision: row.decision,
        actionsTaken: row.actions_taken,
        accountValue: row.account_value,
        positionsCount: row.positions_count,
      }));
      
      return c.json({ logs });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  /**
   * 获取交易统计
   */
  app.get("/api/stats", async (c) => {
    try {
      const startResult = await dbClient.execute(
        "SELECT timestamp FROM account_history ORDER BY timestamp ASC LIMIT 1",
      );
      const sinceTimestamp = startResult.rows[0]?.timestamp as string | undefined;
      const hasSince = typeof sinceTimestamp === "string" && sinceTimestamp.length > 0;

      const statsWhere: string[] = ["status != 'system-close'"];
      const statsArgs: any[] = [];
      if (hasSince) {
        statsWhere.push("timestamp >= ?");
        statsArgs.push(sinceTimestamp);
      }
      const statsWhereClause = statsWhere.length > 0 ? `WHERE ${statsWhere.join(" AND ")}` : "";

      const aggregates = await dbClient.execute({
        sql: `
          SELECT
            SUM(CASE WHEN type = 'close' AND pnl IS NOT NULL THEN 1 ELSE 0 END) AS closed_trades,
            SUM(CASE WHEN type = 'close' AND pnl IS NOT NULL AND pnl > 0 THEN 1 ELSE 0 END) AS win_trades,
            SUM(CASE WHEN type = 'close' AND pnl IS NOT NULL AND pnl < 0 THEN 1 ELSE 0 END) AS loss_trades,
            SUM(CASE WHEN type = 'close' AND pnl IS NOT NULL THEN pnl ELSE 0 END) AS total_pnl,
            SUM(CASE WHEN type = 'close' AND pnl IS NOT NULL AND pnl > 0 THEN pnl ELSE 0 END) AS gross_profit,
            SUM(CASE WHEN type = 'close' AND pnl IS NOT NULL AND pnl < 0 THEN pnl ELSE 0 END) AS gross_loss,
            AVG(CASE WHEN type = 'close' AND pnl IS NOT NULL AND pnl > 0 THEN pnl END) AS avg_win,
            AVG(CASE WHEN type = 'close' AND pnl IS NOT NULL AND pnl < 0 THEN pnl END) AS avg_loss,
            COUNT(*) AS execution_count,
            SUM(COALESCE(fee, 0)) AS total_fee,
            AVG(COALESCE(fee, 0)) AS avg_fee
          FROM trades
          ${statsWhereClause}
        `,
        args: statsArgs.length > 0 ? statsArgs : undefined,
      });

      const row = aggregates.rows[0] ?? {};
      const totalTrades = Number(row.closed_trades ?? 0) || 0;
      const winTrades = Number(row.win_trades ?? 0) || 0;
      const lossTrades = Number(row.loss_trades ?? 0) || 0;
      const totalPnl = Number(row.total_pnl ?? 0) || 0;
      const grossProfit = Number(row.gross_profit ?? 0) || 0;
      const grossLossRaw = Number(row.gross_loss ?? 0) || 0; // 负值
      const grossLoss = Math.abs(grossLossRaw);
      const avgWin = Number(row.avg_win ?? 0) || 0;
      const avgLoss = Number(row.avg_loss ?? 0) || 0; // 负值
      const totalFee = Number(row.total_fee ?? 0) || 0;
      const avgFee = Number(row.avg_fee ?? 0) || 0;
      const executionCount = Number(row.execution_count ?? 0) || 0;

      const winRate = totalTrades > 0 ? (winTrades / totalTrades) * 100 : 0;
      const profitFactor =
        grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0;

      return c.json({
        totalTrades,
        winTrades,
        lossTrades,
        winRate,
        profitFactor: Number.isFinite(profitFactor) ? profitFactor : null,
        totalPnl,
        averageWin: avgWin,
        averageLoss: avgLoss,
        totalFee,
        averageFee: avgFee,
        executions: executionCount,
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  /**
   * 获取多个币种的实时价格
   */
  app.get("/api/prices", async (c) => {
    try {
      const symbolsParam = c.req.query("symbols") || "BTC,ETH,SOL,BNB,DOGE,XRP";
      const symbols = symbolsParam.split(",").map(s => s.trim());
      
      const exchangeClient = createExchangeClient();
      const prices: Record<string, number> = {};
      
      // 并发获取所有币种价格
      await Promise.all(
        symbols.map(async (symbol) => {
          try {
            const contract = `${symbol}_USDT`;
            const ticker = await exchangeClient.getFuturesTicker(contract);
            prices[symbol] = Number.parseFloat(ticker.last || "0");
          } catch (error: any) {
            logger.error(`获取 ${symbol} 价格失败:`, error);
            prices[symbol] = 0;
          }
        })
      );
      
      return c.json({ prices });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  /**
   * 获取量化技术报告
   */
  app.get("/api/quant-reports", async (c) => {
    try {
      const reports = getCachedQuantReports();
      return c.json({ reports });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  return app;
}
