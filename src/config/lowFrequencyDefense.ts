/**
 * 低频 Agent 系统级防守点位配置
 */

export interface LowFrequencyDefenseConfig {
	/**
	 * Tool 是否可用。当前默认为 true，仅在显式关闭时禁用。
	 */
	toolEnabled: boolean;
	/**
	 * 是否启用系统级点位突破监控。
	 */
	monitoringEnabled: boolean;
	/**
	 * 监控轮询间隔（毫秒）。
	 */
	checkIntervalMs: number;
	/**
	 * 连续两次因防守点位触发 LLM 决策之间的冷却时间（毫秒）。
	 */
	forceDecisionCooldownMs: number;
}

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_COOLDOWN_MS = 60_000;

function parseInteger(value: string | undefined, fallback: number): number {
	if (!value) {
		return fallback;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(
	value: string | undefined,
	defaultValue: boolean,
): boolean {
	if (value === undefined) {
		return defaultValue;
	}
	return value.trim().toLowerCase() === "true";
}

export function getLowFrequencyDefenseConfig(): LowFrequencyDefenseConfig {
	const toolEnabled = parseBoolean(
		process.env.LOW_FREQ_DEFENSE_TOOL_ENABLED,
		true,
	);
	const monitoringEnabled = parseBoolean(
		process.env.LOW_FREQ_DEFENSE_MONITOR_ENABLED,
		true,
	);
	const checkIntervalMs = Math.max(
		1000,
		parseInteger(
			process.env.LOW_FREQ_DEFENSE_MONITOR_INTERVAL_MS,
			DEFAULT_INTERVAL_MS,
		),
	);
	const forceDecisionCooldownMs = Math.max(
		0,
		parseInteger(
			process.env.LOW_FREQ_DEFENSE_FORCE_DECISION_COOLDOWN_MS,
			DEFAULT_COOLDOWN_MS,
		),
	);

	return {
		toolEnabled,
		monitoringEnabled,
		checkIntervalMs,
		forceDecisionCooldownMs,
	};
}
