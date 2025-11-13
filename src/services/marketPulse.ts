import { EventEmitter } from "node:events";
import { createPinoLogger } from "@voltagent/logger";
import {
	type MarketPulseConfig,
	getMarketPulseConfig,
} from "../config/marketPulse";
import type { MarketPulseEvent } from "../types/marketPulse";
import { createExchangeClient } from "./exchanges";

const logger = createPinoLogger({
	name: "market-pulse",
	level: "info",
});

interface PriceSample {
	timestamp: number;
	price: number;
}

class MarketPulseWatcher extends EventEmitter {
	private timer: NodeJS.Timeout | null = null;
	private samples: PriceSample[] = [];
	private lastTriggerAt = 0;
	private latestEvent: MarketPulseEvent | null = null;
	private isStopped = false;

	constructor(private readonly config: MarketPulseConfig) {
		super();
	}

	start() {
		if (this.timer || !this.config.enabled) {
			return;
		}
		logger.info(
			`市场脉冲监控已开启：${this.config.symbol}, 窗口 ${this.config.windowSeconds}s, 阈值 +${this.config.triggerUpPercent}% / -${this.config.triggerDownPercent}%`,
		);
		this.scheduleNextTick(0);
	}

	stop() {
		this.isStopped = true;
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = null;
		this.samples = [];
	}

	getLatestEvent(): MarketPulseEvent | null {
		return this.latestEvent;
	}

	private scheduleNextTick(delayMs?: number) {
		if (this.isStopped) {
			return;
		}
		const delay =
			delayMs !== undefined
				? Math.max(delayMs, 0)
				: Math.max(this.config.pollIntervalMs, 500);
		this.timer = setTimeout(() => {
			this.pollTicker()
				.catch((error: unknown) => {
					const reason =
						error instanceof Error ? error.message : String(error);
					logger.warn(`市场脉冲监控：轮询失败 (${reason})`);
				})
				.finally(() => {
					this.scheduleNextTick(this.config.pollIntervalMs);
				});
		}, delay);
	}

	private async pollTicker() {
		if (this.isStopped) {
			return;
		}
		const exchangeClient = createExchangeClient();
		const ticker = await exchangeClient.getFuturesTicker(this.config.contract);
		const priceCandidate =
			ticker?.last ??
			ticker?.close ??
			ticker?.markPrice ??
			ticker?.mark_price ??
			ticker?.price;
		const price =
			typeof priceCandidate === "number"
				? priceCandidate
				: Number.parseFloat(priceCandidate ?? "0");

		if (!Number.isFinite(price) || price <= 0) {
			logger.warn(
				`市场脉冲监控：${this.config.contract} 价格异常 (${priceCandidate})`,
			);
			return;
		}

		const now = Date.now();
		this.samples.push({ timestamp: now, price });
		this.trimSamples(now);
		this.evaluateSamples(now);
	}

	private trimSamples(now: number) {
		const cutoff = now - this.config.windowSeconds * 1000;
		while (this.samples.length > 0 && this.samples[0].timestamp < cutoff) {
			this.samples.shift();
		}
		// 保底：只保留最近 500 条，避免极端情况下内存增长
		if (this.samples.length > 500) {
			this.samples.splice(0, this.samples.length - 500);
		}
	}

	private evaluateSamples(now: number) {
		if (this.samples.length < 2) {
			return;
		}
		const oldest = this.samples[0];
		const latest = this.samples[this.samples.length - 1];
		if (latest.price <= 0 || oldest.price <= 0) {
			return;
		}
		const percentChange = ((latest.price - oldest.price) / oldest.price) * 100;

		let direction: MarketPulseEvent["direction"] | null = null;
		let thresholdPercent = 0;

		if (percentChange <= -this.config.triggerDownPercent) {
			direction = "down";
			thresholdPercent = this.config.triggerDownPercent;
		} else if (percentChange >= this.config.triggerUpPercent) {
			direction = "up";
			thresholdPercent = this.config.triggerUpPercent;
		}

		if (!direction) {
			return;
		}

		if (now - this.lastTriggerAt < this.config.cooldownMs) {
			logger.debug("市场脉冲监控：处于冷却窗口，跳过强制触发。");
			return;
		}

		const event: MarketPulseEvent = {
			symbol: this.config.symbol,
			contract: this.config.contract,
			direction,
			percentChange,
			thresholdPercent,
			windowSeconds: this.config.windowSeconds,
			fromPrice: oldest.price,
			toPrice: latest.price,
			triggeredAt: new Date(now).toISOString(),
			sampleCount: this.samples.length,
		};

		this.lastTriggerAt = now;
		this.latestEvent = event;
		logger.warn(
			`检测到 ${this.config.symbol} ${
				direction === "down" ? "下跌" : "上涨"
			} ${percentChange.toFixed(2)}%（窗口 ${this.config.windowSeconds}s）`,
		);
		this.emit("volatilitySpike", event);
	}
}

let watcher: MarketPulseWatcher | null = null;

export function startMarketPulseWatcher(
	handler?: (event: MarketPulseEvent) => void,
): MarketPulseWatcher | null {
	const config = getMarketPulseConfig();
	if (!config.enabled) {
		logger.info("市场脉冲监控未启用。");
		return null;
	}
	if (!watcher) {
		watcher = new MarketPulseWatcher(config);
		watcher.start();
	}
	if (handler) {
		watcher.on("volatilitySpike", handler);
	}
	return watcher;
}

export function stopMarketPulseWatcher(
	handler?: (event: MarketPulseEvent) => void,
) {
	if (!watcher) {
		return;
	}
	if (handler) {
		watcher.off("volatilitySpike", handler);
	}
	if (watcher.listenerCount("volatilitySpike") === 0) {
		watcher.stop();
		watcher = null;
	}
}

export function getLatestMarketPulseEvent(): MarketPulseEvent | null {
	return watcher?.getLatestEvent() ?? null;
}
