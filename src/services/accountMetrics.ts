import { isDryRunMode } from "./exchanges";

export interface NormalizedAccountSnapshot {
  rawTotal: number;
  availableBalance: number;
  positionMargin: number;
  unrealisedPnl: number;
  realizedBalance: number;
  equity: number;
  includesUnrealisedInTotal: boolean;
}

function parseAmount(value: unknown, fallback = 0): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/**
 * 归一化交易所返回的账户资产数据，补齐 dry-run 与真实交易所之间的字段差异。
 */
export function normalizeAccountSnapshot(account: any): NormalizedAccountSnapshot {
  const includesUnrealised = isDryRunMode();

  const rawTotal =
    parseAmount(account?.total) ??
    parseAmount(account?.marginBalance) ??
    parseAmount(account?.totalWalletBalance);

  const availableBalance =
    parseAmount(account?.available) ??
    parseAmount(account?.availableBalance);

  const positionMargin =
    parseAmount(account?.positionMargin) ??
    parseAmount(account?.totalPositionInitialMargin);

  const unrealisedPnl =
    parseAmount(account?.unrealisedPnl) ??
    parseAmount(account?.unRealizedProfit);

  let realizedBalance = includesUnrealised ? rawTotal - unrealisedPnl : rawTotal;
  if (!Number.isFinite(realizedBalance)) {
    realizedBalance = 0;
  }
  // 浮点误差可能导致极小的负数，向上截到 8 位精度
  if (realizedBalance < 0 && realizedBalance > -1e-8) {
    realizedBalance = 0;
  }

  const equity = includesUnrealised ? rawTotal : rawTotal + unrealisedPnl;

  return {
    rawTotal,
    availableBalance,
    positionMargin,
    unrealisedPnl,
    realizedBalance,
    equity,
    includesUnrealisedInTotal: includesUnrealised,
  };
}
