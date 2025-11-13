export type MarketPulseDirection = "up" | "down";

export interface MarketPulseEvent {
	symbol: string;
	contract: string;
	direction: MarketPulseDirection;
	percentChange: number;
	thresholdPercent: number;
	windowSeconds: number;
	fromPrice: number;
	toPrice: number;
	triggeredAt: string;
	sampleCount: number;
}
