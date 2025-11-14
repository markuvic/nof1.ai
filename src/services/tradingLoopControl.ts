/**
 * tradingLoopControl - 负责在 Scheduler 与 LLM 工具之间传递下一次循环的调度请求
 */

export type TradingLoopRescheduleReason = "llm-override" | "system";

type RescheduleHandler = (reason: TradingLoopRescheduleReason) => void;

let pendingOverrideMinutes: number | null = null;
let rescheduleHandler: RescheduleHandler | null = null;

/**
 * 注册调度器回调，由 scheduler 注入
 */
export function registerTradingLoopRescheduleHandler(
  handler: RescheduleHandler,
) {
  rescheduleHandler = handler;
}

/**
 * 由 scheduler 消费并清空待处理的覆盖时间
 */
export function consumePendingLoopOverride(): number | null {
  const minutes = pendingOverrideMinutes;
  pendingOverrideMinutes = null;
  return minutes;
}

export function peekPendingLoopOverride(): number | null {
  return pendingOverrideMinutes;
}

/**
 * 由工具或系统请求下一次循环的延迟
 */
export function requestNextLoopOverride(
  minutes: number,
  reason: TradingLoopRescheduleReason = "llm-override",
) {
  pendingOverrideMinutes = minutes;
  if (rescheduleHandler) {
    rescheduleHandler(reason);
  }
}
