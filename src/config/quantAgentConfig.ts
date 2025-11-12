import { RISK_PARAMS } from "./riskParams";

export interface QuantAgentInterval {
  frame: string;
  limit: number;
}

export interface QuantModelConfig {
  indicatorModel: string;
  visionModel: string;
  decisionModel: string;
}

export interface QuantAgentConfig {
  enabledSymbols: string[];
  intervals: QuantAgentInterval[];
  reportsBaseDir: string;
  imageWidth: number;
  imageHeight: number;
  cacheTtlMs: number;
  maxConcurrentSymbols: number;
  models: QuantModelConfig;
}

function getEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getEnvString(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

const defaultIntervals: QuantAgentInterval[] = [
  { frame: "15m", limit: 96 }
];

export const QUANT_AGENT_CONFIG: QuantAgentConfig = {
  enabledSymbols: RISK_PARAMS.TRADING_SYMBOLS,
  intervals: defaultIntervals,
  reportsBaseDir: ".voltagent/quant-reports",
  imageWidth: getEnvNumber("QUANT_IMAGE_WIDTH", 1024),
  imageHeight: getEnvNumber("QUANT_IMAGE_HEIGHT", 640),
  cacheTtlMs: getEnvNumber("QUANT_REPORT_CACHE_TTL_MS", 5 * 60 * 1000),
  maxConcurrentSymbols: getEnvNumber("QUANT_REPORT_MAX_CONCURRENCY", 2),
  models: {
    indicatorModel: getEnvString("QUANT_INDICATOR_MODEL", "gpt-4o-mini"),
    visionModel: getEnvString("QUANT_VISION_MODEL", "gpt-4o-mini"),
    decisionModel: getEnvString("QUANT_DECISION_MODEL", "gpt-4o-mini"),
  },
};

export type { QuantAgentConfig as QuantConfig };
