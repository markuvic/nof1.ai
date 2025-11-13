export interface MarketPulseConfig {
	enabled: boolean;
	symbol: string;
	contract: string;
	triggerUpPercent: number;
	triggerDownPercent: number;
	windowSeconds: number;
	pollIntervalMs: number;
	cooldownMs: number;
	minGapToNextRunMs: number;
	telegramNotifyEnabled: boolean;
}

function parseNumber(
	value: string | undefined,
	fallback: number,
	{ min, max }: { min?: number; max?: number } = {},
): number {
	if (value === undefined || value === null || value === "") {
		return fallback;
	}
	const parsed = Number.parseFloat(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	if (min !== undefined && parsed < min) {
		return min;
	}
	if (max !== undefined && parsed > max) {
		return max;
	}
	return parsed;
}

export function getMarketPulseConfig(): MarketPulseConfig {
	const enabled = process.env.MARKET_PULSE_ENABLED === "true";
	const symbol = (process.env.MARKET_PULSE_SYMBOL || "BTC").toUpperCase();
	const contract = process.env.MARKET_PULSE_CONTRACT || `${symbol}_USDT`;

	const triggerUpPercent = parseNumber(
		process.env.MARKET_PULSE_TRIGGER_UP_PERCENT,
		2,
		{ min: 0 },
	);
	const triggerDownPercent = parseNumber(
		process.env.MARKET_PULSE_TRIGGER_DOWN_PERCENT,
		1.5,
		{ min: 0 },
	);

	const windowSeconds = parseNumber(
		process.env.MARKET_PULSE_LOOKBACK_SECONDS,
		90,
		{ min: 10 },
	);
	const pollIntervalMs = parseNumber(
		process.env.MARKET_PULSE_POLL_INTERVAL_MS,
		5000,
		{ min: 500 },
	);

	const cooldownMs =
		parseNumber(process.env.MARKET_PULSE_COOLDOWN_SECONDS, 60, { min: 5 }) *
		1000;
	const minGapToNextRunMs =
		parseNumber(process.env.MARKET_PULSE_MIN_GAP_SECONDS, 120, { min: 0 }) *
		1000;
	const telegramNotifyEnabled =
		process.env.MARKET_PULSE_TELEGRAM_NOTIFY !== "false";

	return {
		enabled,
		symbol,
		contract,
		triggerUpPercent,
		triggerDownPercent,
		windowSeconds,
		pollIntervalMs,
		cooldownMs,
		minGapToNextRunMs,
		telegramNotifyEnabled,
	};
}
