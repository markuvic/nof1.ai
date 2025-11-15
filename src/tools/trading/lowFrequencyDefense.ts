import { createTool } from "@voltagent/core";
import { z } from "zod";
import { createPinoLogger } from "@voltagent/logger";
import { RISK_PARAMS } from "../../config/riskParams";
import { getLowFrequencyDefenseConfig } from "../../config/lowFrequencyDefense";
import { upsertDefenseLevels } from "../../services/lowFrequencyAgent/defenseLevels";
import { isLowFrequencyAgentProfile } from "../../utils/agentProfile";

const logger = createPinoLogger({
	name: "low-frequency-defense-tool",
	level: (process.env.LOG_LEVEL || "info") as any,
});

const defenseConfig = getLowFrequencyDefenseConfig();

const notesSchema = z
	.string()
	.max(300)
	.describe("可选：补充说明或结构判断依据")
	.optional();

export const setDefenseLevelsTool = createTool({
	name: "setDefenseLevels",
	description:
		"低频 Agent 専用：为当前仓位设定系统级防守点位。entry_invalidation 来源于 15m/1h 的局部结构失效位；structure_invalidation 来源于 1h/4h/1d 的趋势失效位。系统会轮询监控，一旦被突破将强制触发 LLM 决策。",
	parameters: z.object({
		symbol: z
			.enum(RISK_PARAMS.TRADING_SYMBOLS)
			.describe("交易对（如 BTC/ETH/XRP），必须与当前开仓一致"),
		side: z
			.enum(["long", "short"])
			.describe("当前仓位方向：多头 long，空头 short"),
		entryInvalidation: z
			.number()
			.positive()
			.describe(
				"入场失效价（小周期 15m/1h）：多头跌破 / 空头突破则结构失效",
			),
		structureInvalidation: z
			.number()
			.positive()
			.describe(
				"趋势结构失效价（1h/4h/1d）：趋势破坏或关键支撑/阻力失守价位",
			),
		notes: notesSchema,
	}),
	execute: async ({
		symbol,
		side,
		entryInvalidation,
		structureInvalidation,
		notes,
	}) => {
		if (!defenseConfig.toolEnabled) {
			const message =
				"低频防守点位工具已被禁用（LOW_FREQ_DEFENSE_TOOL_ENABLED=false）。";
			logger.warn(message);
			return {
				success: false,
				message,
			};
		}

		if (!isLowFrequencyAgentProfile(process.env.AI_AGENT_PROFILE)) {
			logger.warn(
				`setDefenseLevels 工具仅针对低频 Agent，当前 profile=${process.env.AI_AGENT_PROFILE ?? "default"}`,
			);
		}

		await upsertDefenseLevels({
			symbol,
			side,
			entryInvalidation,
			structureInvalidation,
			notes,
		});

		return {
			success: true,
			message: `已为 ${symbol} ${side} 仓位设定防守：entry=${entryInvalidation}, structure=${structureInvalidation}`,
		};
	},
});
