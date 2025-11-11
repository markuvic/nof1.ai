import { QUANT_AGENT_CONFIG } from "../../config/quantAgentConfig";
import { loadSymbolFrames } from "./marketData";
import { renderQuantImages } from "./imageRenderer";
import {
  runPatternAgent,
  runTrendAgent,
  runDecisionAgent,
} from "./agents";
import type { QuantReport, QuantDecision } from "./types";
import type { QuantReportContext } from "./types";
import { buildIndicatorNarrative } from "./indicatorMath";

const reportCache = new Map<string, { timestamp: number; report: QuantReport }>();
const KLINE_CACHE_BASE = ".voltagent/kline-cache";

function extractJsonPayload(text: string): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    return fenceMatch[1].trim();
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return null;
}

function parseDecision(decisionText: string): QuantDecision {
  const payload = extractJsonPayload(decisionText) ?? decisionText;
  try {
    const parsed = JSON.parse(payload);
    return {
      forecastHorizon: parsed.forecast_horizon || "未知",
      decision: parsed.decision || "OBSERVE",
      justification: parsed.justification || "无明确结论",
      riskRewardRatio: parsed.risk_reward_ratio || "1.3",
      rawText: decisionText,
    };
  } catch (error) {
    return {
      forecastHorizon: "未知",
      decision: "OBSERVE",
      justification: "JSON 解析失败，原始输出：" + decisionText,
      riskRewardRatio: "1.3",
      rawText: decisionText,
    };
  }
}

function summarizeError(reason: unknown): string {
  if (!reason) return "未知错误";
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

export async function generateQuantReport(symbol: string): Promise<QuantReport> {
  const cached = reportCache.get(symbol);
  if (
    cached &&
    Date.now() - cached.timestamp < QUANT_AGENT_CONFIG.cacheTtlMs
  ) {
    return cached.report;
  }

  const market = await loadSymbolFrames(symbol, QUANT_AGENT_CONFIG.intervals, KLINE_CACHE_BASE);
  const primaryFrame = market.frames[0];
  if (!primaryFrame) {
    throw new Error(`未找到 ${symbol} 的 K 线数据`);
  }

  const images = await renderQuantImages(primaryFrame.candles, {
    symbol,
    frame: primaryFrame.frame,
    width: QUANT_AGENT_CONFIG.imageWidth,
    height: QUANT_AGENT_CONFIG.imageHeight,
    outputDir: QUANT_AGENT_CONFIG.reportsBaseDir,
  });

  const context: QuantReportContext = {
    symbol,
    frame: primaryFrame,
    patternImageBase64: images.patternBase64,
    patternImagePath: images.patternImagePath,
    trendImageBase64: images.trendBase64,
    trendImagePath: images.trendImagePath,
  };

  const indicatorReport = buildIndicatorNarrative(primaryFrame.candles);
  const [patternResult, trendResult] = await Promise.allSettled([
    runPatternAgent(context),
    runTrendAgent(context),
  ]);

  const patternReport =
    patternResult.status === "fulfilled"
      ? patternResult.value
      : `形态代理失败：${summarizeError(patternResult.reason)}`;
  const trendReport =
    trendResult.status === "fulfilled"
      ? trendResult.value
      : `趋势代理失败：${summarizeError(trendResult.reason)}`;

  const decisionRaw = await runDecisionAgent({
    symbol,
    frame: primaryFrame.frame,
    indicatorReport,
    patternReport,
    trendReport,
  });
  const decision = parseDecision(decisionRaw);

  const report: QuantReport = {
    symbol,
    frame: primaryFrame.frame,
    market,
    indicatorReport,
    patternReport,
    trendReport,
    decision,
    patternImagePath: images.patternImagePath,
    trendImagePath: images.trendImagePath,
    generatedAt: Date.now(),
  };

  reportCache.set(symbol, { timestamp: Date.now(), report });
  return report;
}

export async function generateQuantReports(symbols: string[]): Promise<QuantReport[]> {
  const reports: QuantReport[] = [];
  for (const symbol of symbols) {
    try {
      const report = await generateQuantReport(symbol);
      reports.push(report);
    } catch (error) {
      const fallback: QuantReport = {
        symbol,
        frame: QUANT_AGENT_CONFIG.intervals[0]?.frame ?? "unknown",
        market: {
          symbol,
          frames: [],
          fetchedAt: Date.now(),
        },
        indicatorReport: `生成失败：${summarizeError(error)}`,
        patternReport: "形态数据不可用",
        trendReport: "趋势数据不可用",
        decision: {
          forecastHorizon: "未知",
          decision: "OBSERVE",
          justification: "量化报告生成失败，建议人工确认。",
          riskRewardRatio: "1.3",
          rawText: "",
        },
        patternImagePath: "",
        trendImagePath: "",
        generatedAt: Date.now(),
      };
      reportCache.set(symbol, { timestamp: Date.now(), report: fallback });
      reports.push(fallback);
    }
  }
  return reports;
}

export function getCachedQuantReports(): QuantReport[] {
  return Array.from(reportCache.entries())
    .sort((a, b) => (b[1].timestamp ?? 0) - (a[1].timestamp ?? 0))
    .map(([, entry]) => entry.report);
}
