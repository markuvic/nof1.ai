import { sendTradeNotification } from "./telegramBot";
import { createPinoLogger } from "@voltagent/logger";

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
