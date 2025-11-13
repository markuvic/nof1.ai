import type { MarketPulseEvent } from "../types/marketPulse";

export function describeMarketPulseEvent(
	event?: MarketPulseEvent | null,
): string | null {
	if (!event) {
		return null;
	}
	const directionText = event.direction === "down" ? "下跌" : "上涨";
	const percent = Number.isFinite(event.percentChange)
		? event.percentChange.toFixed(2)
		: "0";
	const fromPrice = Number.isFinite(event.fromPrice)
		? event.fromPrice.toFixed(2)
		: "-";
	const toPrice = Number.isFinite(event.toPrice)
		? event.toPrice.toFixed(2)
		: "-";
	return `⚡ 市场脉冲触发（${event.symbol}）：在 ${event.windowSeconds} 秒内${directionText} ${percent}%，超过阈值 ${event.thresholdPercent}%（价格 ${fromPrice} → ${toPrice}）。`;
}
