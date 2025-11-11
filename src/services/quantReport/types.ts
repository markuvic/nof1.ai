import type { FrameDataset, SymbolMarketSnapshot } from "./marketData";

export interface QuantAgentSegment {
  indicatorReport: string;
  patternReport: string;
  trendReport: string;
}

export interface QuantDecision {
  forecastHorizon: string;
  decision: "LONG" | "SHORT" | "OBSERVE" | string;
  justification: string;
  riskRewardRatio: string;
  rawText: string;
}

export interface QuantReport {
  symbol: string;
  frame: string;
  market: SymbolMarketSnapshot;
  indicatorReport: string;
  patternReport: string;
  trendReport: string;
  decision: QuantDecision;
  patternImagePath: string;
  trendImagePath: string;
  generatedAt: number;
}

export interface QuantReportContext {
  symbol: string;
  frame: FrameDataset;
  patternImageBase64: string;
  patternImagePath: string;
  trendImageBase64: string;
  trendImagePath: string;
}
