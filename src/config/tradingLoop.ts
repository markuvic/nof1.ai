/**
 * open-nof1.ai - AI 加密货币自动交易系统
 */

export interface TradingLoopConfig {
	/**
	 * 固定的默认执行间隔（分钟）
	 */
	defaultIntervalMinutes: number;
	/**
	 * 是否允许 LLM 通过工具动态调整下一次执行间隔
	 */
	llmControlEnabled: boolean;
	/**
	 * LLM 调整间隔的最小限制
	 */
	llmMinIntervalMinutes: number;
	/**
	 * LLM 调整间隔的最大限制
	 */
	llmMaxIntervalMinutes: number;
}

const DEFAULT_INTERVAL_MINUTES = 5;
const DEFAULT_MIN_MINUTES = 5;
const DEFAULT_MAX_MINUTES = 240;

function parseInteger(value: string | undefined, fallback: number): number {
	if (!value) {
		return fallback;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
	if (value < min) {
		return min;
	}
	if (value > max) {
		return max;
	}
	return value;
}

/**
 * 读取交易循环配置
 */
export function getTradingLoopConfig(): TradingLoopConfig {
	const defaultIntervalMinutes = Math.max(
		1,
		parseInteger(
			process.env.TRADING_INTERVAL_MINUTES,
			DEFAULT_INTERVAL_MINUTES,
		),
	);

	const llmControlEnabled = process.env.LLM_LOOP_CONTROL_ENABLED === "true";

	const minMinutes = clamp(
		parseInteger(process.env.LLM_LOOP_MIN_MINUTES, DEFAULT_MIN_MINUTES),
		DEFAULT_MIN_MINUTES,
		DEFAULT_MAX_MINUTES,
	);

	const rawMaxMinutes = clamp(
		parseInteger(process.env.LLM_LOOP_MAX_MINUTES, DEFAULT_MAX_MINUTES),
		DEFAULT_MIN_MINUTES,
		DEFAULT_MAX_MINUTES,
	);

	const maxMinutes = Math.max(minMinutes, rawMaxMinutes);

	return {
		defaultIntervalMinutes,
		llmControlEnabled,
		llmMinIntervalMinutes: minMinutes,
		llmMaxIntervalMinutes: maxMinutes,
	};
}
