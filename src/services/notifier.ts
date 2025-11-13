import { createPinoLogger } from "@voltagent/logger";
import { sendTradeNotification, sendAlertNotification } from "./telegramBot";
import type { MarketPulseEvent } from "../types/marketPulse";
import { describeMarketPulseEvent } from "../utils/marketPulseUtils";
import { formatChinaTime } from "../utils/timeUtils";

const logger = createPinoLogger({
  name: "notifier",
  level: "info",
});

export interface TradeOpenEvent {
  symbol: string;
  side: "long" | "short";
  leverage: number;
  contracts: number;
  entryPrice: number;
  margin: number;
  baseAmount: number;
}

export interface TradeCloseEvent {
  symbol: string;
  side: "long" | "short";
  contracts: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  fee: number;
  baseAmount: number;
}

export async function notifyTradeOpened(event: TradeOpenEvent) {
  try {
    const baseAmount = Math.abs(event.baseAmount);
    const notional = Math.abs(baseAmount * event.entryPrice);
    await sendTradeNotification({
      kind: "open",
      symbol: event.symbol,
      side: event.side,
      leverage: event.leverage,
      contracts: Math.abs(event.contracts),
      baseAmount,
      entryPrice: event.entryPrice,
      margin: event.margin,
      notional,
    });
  } catch (error) {
    logger.warn(`发送开仓通知失败: ${(error as Error).message}`);
  }
}

export async function notifyTradeClosed(event: TradeCloseEvent) {
  try {
    const baseAmount = Math.abs(event.baseAmount);
    await sendTradeNotification({
      kind: "close",
      symbol: event.symbol,
      side: event.side,
      contracts: Math.abs(event.contracts),
      baseAmount,
      entryPrice: event.entryPrice,
      exitPrice: event.exitPrice,
      pnl: event.pnl,
      fee: event.fee,
    });
  } catch (error) {
    logger.warn(`发送平仓通知失败: ${(error as Error).message}`);
  }
}

export async function notifyMarketPulseTriggered(
  event: MarketPulseEvent,
  extras?: { nextRunSeconds?: number },
) {
  try {
    const summary = describeMarketPulseEvent(event) ?? "市场脉冲触发";
    const nextRunSeconds = extras?.nextRunSeconds;
    const lines = [
      summary.replace(/^⚡\s*/, "").trim(),
      `触发方向：${event.direction === "down" ? "急跌" : "急涨"}，幅度 ${event.percentChange.toFixed(2)}%`,
      `价格区间：${event.fromPrice.toFixed(2)} → ${event.toPrice.toFixed(2)} USDT`,
      `检测窗口：${event.windowSeconds}s，采样 ${event.sampleCount} 条`,
      `触发时间：${formatChinaTime(event.triggeredAt)}`,
    ];
    if (typeof nextRunSeconds === "number") {
      lines.push(`距下一次常规决策约 ${Math.max(0, nextRunSeconds)} 秒`);
    }
    await sendAlertNotification({
      title: "市场脉冲提醒",
      emoji: event.direction === "down" ? "🚨" : "⚡",
      lines,
    });
  } catch (error) {
    logger.warn(`发送市场脉冲通知失败: ${(error as Error).message}`);
  }
}
