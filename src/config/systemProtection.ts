export interface SystemProtectionConfig {
  enabled: boolean;
  takeProfitEnabled: boolean;
  stopLossEnabled: boolean;
  trailingEnabled: boolean;
  timeoutProfitEnabled: boolean;
  takeProfitPercent: number;
  takeProfitClosePercent: number;
  takeProfitMaxTriggers: number;
  stopLossPercent: number;
  stopLossClosePercent: number;
  trailingTiers: Array<{
    trigger: number;
    lock: number;
    closePercent: number;
  }>;
  checkIntervalMs: number;
  timeoutMinHoldMinutes: number;
  timeoutDrawdownPercent: number;
  timeoutClosePercent: number;
  timeoutMinPeakPercent: number;
  timeoutMinCloseContracts: number;
}

function parsePercent(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseIntervalSeconds(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  if (percent < 0) return 0;
  if (percent > 100) return 100;
  return percent;
}

function parseTrailingTiers(raw?: string): Array<{
  trigger: number;
  lock: number;
  closePercent: number;
}> {
  if (!raw) return [];
  const tiers = raw
    .split(/[,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [triggerStr, lockStr, closeStr] = entry
        .split(":")
        .map((part) => part.trim());
      const trigger = Number.parseFloat(triggerStr ?? "");
      if (!Number.isFinite(trigger) || trigger <= 0) {
        return null;
      }
      const lockValue = Number.parseFloat(lockStr ?? "");
      const lock = Number.isFinite(lockValue) ? lockValue : trigger / 2;
      const closeValue = Number.parseFloat(closeStr ?? "");
      const closePercent = clampPercent(
        Number.isFinite(closeValue) ? closeValue : 100,
      );
      return {
        trigger,
        lock,
        closePercent,
      };
    })
    .filter((tier): tier is { trigger: number; lock: number; closePercent: number } => Boolean(tier));
  tiers.sort((a, b) => a.trigger - b.trigger);
  return tiers;
}

export function getSystemProtectionConfig(): SystemProtectionConfig {
  const enabled =
    process.env.SYSTEM_PROTECTION_ENABLED === "true" ||
    process.env.SYSTEM_TP_SL_ENABLED === "true";

  const takeProfitEnabled =
    process.env.SYSTEM_TAKE_PROFIT_ENABLED === "true" ||
    (enabled && process.env.SYSTEM_TAKE_PROFIT_ENABLED !== "false");

  const stopLossEnabled =
    process.env.SYSTEM_STOP_LOSS_ENABLED === "true" ||
    (enabled && process.env.SYSTEM_STOP_LOSS_ENABLED !== "false");

  const trailingTiers = parseTrailingTiers(
    process.env.SYSTEM_TRAILING_TIERS,
  );
  const trailingEnabled =
    process.env.SYSTEM_TRAILING_ENABLED === "true" ||
    trailingTiers.length > 0;

  const timeoutProfitEnabled =
    process.env.SYSTEM_TIMEOUT_PROFIT_ENABLED === "true";
  const timeoutMinHoldMinutes = Math.max(
    1,
    Number.parseInt(process.env.SYSTEM_TIMEOUT_MINUTES || "60", 10),
  );
  const timeoutDrawdownPercent = clampPercent(
    parsePercent(process.env.SYSTEM_TIMEOUT_DRAWDOWN_PERCENT, 50),
  );
  const timeoutClosePercent = clampPercent(
    parsePercent(process.env.SYSTEM_TIMEOUT_CLOSE_PERCENT, 50),
  );
  const timeoutMinPeakPercent = clampPercent(
    parsePercent(process.env.SYSTEM_TIMEOUT_MIN_PEAK_PERCENT, 3),
  );
  const timeoutMinCloseContracts = Math.max(
    0,
    Number.parseInt(
      process.env.SYSTEM_TIMEOUT_MIN_CLOSE_CONTRACTS || "0",
      10,
    ),
  );

  const takeProfitPercent = parsePercent(
    process.env.SYSTEM_TAKE_PROFIT_PERCENT,
    0,
  );
  const takeProfitClosePercent = clampPercent(
    parsePercent(process.env.SYSTEM_TAKE_PROFIT_CLOSE_PERCENT, 50),
  );

  const stopLossPercent = parsePercent(
    process.env.SYSTEM_STOP_LOSS_PERCENT,
    0,
  );
  const stopLossClosePercent = clampPercent(
    parsePercent(process.env.SYSTEM_STOP_LOSS_CLOSE_PERCENT, 100),
  );

  const checkIntervalMs =
    parseIntervalSeconds(
      process.env.SYSTEM_PROTECTION_INTERVAL_SECONDS,
      60,
    ) * 1000;

  return {
    enabled:
      takeProfitEnabled || stopLossEnabled || trailingEnabled || timeoutProfitEnabled,
    takeProfitEnabled,
    stopLossEnabled,
    trailingEnabled,
    timeoutProfitEnabled,
    takeProfitPercent,
    takeProfitClosePercent,
    takeProfitMaxTriggers: Math.max(
      1,
      Number.parseInt(process.env.SYSTEM_TAKE_PROFIT_MAX_TRIGGERS || "3", 10),
    ),
    stopLossPercent,
    stopLossClosePercent,
    trailingTiers,
    checkIntervalMs,
    timeoutMinHoldMinutes,
    timeoutDrawdownPercent,
    timeoutClosePercent,
    timeoutMinPeakPercent,
    timeoutMinCloseContracts,
  };
}
