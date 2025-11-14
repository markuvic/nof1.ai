/**
 * 动态调度工具 - 允许 LLM 设定下一次交易循环的执行时间
 */
import { createTool } from "@voltagent/core";
import { z } from "zod";
import { createPinoLogger } from "@voltagent/logger";
import { getTradingLoopConfig } from "../../config/tradingLoop";
import {
  requestNextLoopOverride,
} from "../../services/tradingLoopControl";

const logger = createPinoLogger({
  name: "trading-loop-tool",
  level: (process.env.LOG_LEVEL || "info") as any,
});

export const setNextTradingCycleIntervalTool = createTool({
  name: "set_next_trading_cycle_interval",
  description:
    "设置下一次交易循环的执行延迟（单位：分钟）。只有在 LLM_LOOP_CONTROL_ENABLED=true 且输入介于系统允许的范围内时才会生效；该工具不会影响之后的循环，若需要再次调整请重新调用。",
  parameters: z.object({
    minutes: z
      .number()
      .int()
      .describe("希望下一次交易循环等待的分钟数，必须在系统允许范围内（默认 5-240 分钟）"),
  }),
  execute: async ({ minutes }) => {
    const config = getTradingLoopConfig();
    const normalizedMinutes = Math.round(minutes);

    if (!config.llmControlEnabled) {
      return {
        success: false,
        message:
          "系统未开启 LLM 动态调度（LLM_LOOP_CONTROL_ENABLED=false），请求被忽略，将按固定周期执行。",
      };
    }

    if (
      normalizedMinutes < config.llmMinIntervalMinutes ||
      normalizedMinutes > config.llmMaxIntervalMinutes
    ) {
      logger.warn(
        `LLM 试图设置非法循环时间: ${normalizedMinutes} 分钟（允许区间 ${config.llmMinIntervalMinutes}-${config.llmMaxIntervalMinutes}）。`,
      );
      return {
        success: false,
        message: `无效的循环时间 ${normalizedMinutes} 分钟。系统要求在 ${config.llmMinIntervalMinutes}-${config.llmMaxIntervalMinutes} 分钟之间，超过范围将继续按默认周期执行。`,
      };
    }

    requestNextLoopOverride(normalizedMinutes, "llm-override");
    logger.info(
      `下一次交易循环已由 LLM 请求调整为 ${normalizedMinutes} 分钟后执行。`,
    );

    return {
      success: true,
      message: `已设置下一次交易循环在 ${normalizedMinutes} 分钟后执行（只对下一次生效）。`,
      nextIntervalMinutes: normalizedMinutes,
      minMinutes: config.llmMinIntervalMinutes,
      maxMinutes: config.llmMaxIntervalMinutes,
    };
  },
});
