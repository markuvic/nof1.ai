import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { createPinoLogger } from "@voltagent/logger";
import type { QuantCandle } from "./marketData";

const logger = createPinoLogger({
  name: "quant-image-renderer",
  level: (process.env.LOG_LEVEL as any) || "info",
});

export interface RenderContext {
  symbol: string;
  frame: string;
  width: number;
  height: number;
  outputDir: string;
}

export interface RenderResult {
  patternImagePath: string;
  patternBase64: string;
  trendImagePath: string;
  trendBase64: string;
}

function ensureDir(path: string) {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function scalePrice(value: number, min: number, max: number, height: number, padding: number) {
  if (max === min) {
    return height / 2;
  }
  const ratio = (value - min) / (max - min);
  return height - padding - ratio * (height - padding * 2);
}

function drawCandlesticks(
  ctx: ReturnType<typeof createCanvas>["getContext"],
  candles: QuantCandle[],
  width: number,
  height: number,
) {
  const padding = 40;
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const maxPrice = Math.max(...highs);
  const minPrice = Math.min(...lows);
  const barWidth = Math.max(3, (width - padding * 2) / candles.length);

  ctx.strokeStyle = "#6b7280";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding, padding / 2);
  ctx.lineTo(padding, height - padding);
  ctx.lineTo(width - padding / 2, height - padding);
  ctx.stroke();

  candles.forEach((candle, index) => {
    const x = padding + index * barWidth + barWidth / 2;
    const openY = scalePrice(candle.open, minPrice, maxPrice, height, padding);
    const closeY = scalePrice(candle.close, minPrice, maxPrice, height, padding);
    const highY = scalePrice(candle.high, minPrice, maxPrice, height, padding);
    const lowY = scalePrice(candle.low, minPrice, maxPrice, height, padding);
    const isBull = candle.close >= candle.open;

    ctx.strokeStyle = isBull ? "#10b981" : "#ef4444";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x, highY);
    ctx.lineTo(x, lowY);
    ctx.stroke();

    ctx.fillStyle = isBull ? "#10b981" : "#ef4444";
    const bodyHeight = Math.max(1, Math.abs(closeY - openY));
    const bodyY = Math.min(openY, closeY);
    ctx.fillRect(x - barWidth * 0.35, bodyY, barWidth * 0.7, bodyHeight);
  });
}

function drawPivotMarkers(
  ctx: ReturnType<typeof createCanvas>["getContext"],
  candles: QuantCandle[],
  width: number,
  height: number,
) {
  const padding = 40;
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const maxPrice = Math.max(...highs);
  const minPrice = Math.min(...lows);
  const barWidth = Math.max(3, (width - padding * 2) / candles.length);

  const pivots: { index: number; price: number; type: "high" | "low" }[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const window = candles.slice(i - 2, i + 3);
    const current = candles[i];
    if (current.high === Math.max(...window.map((c) => c.high))) {
      pivots.push({ index: i, price: current.high, type: "high" });
    } else if (current.low === Math.min(...window.map((c) => c.low))) {
      pivots.push({ index: i, price: current.low, type: "low" });
    }
  }

  pivots.slice(-8).forEach((pivot) => {
    const x = padding + pivot.index * barWidth + barWidth / 2;
    const priceY = scalePrice(pivot.price, minPrice, maxPrice, height, padding);
    ctx.fillStyle = pivot.type === "high" ? "#f97316" : "#3b82f6";
    ctx.beginPath();
    ctx.arc(x, priceY, 4, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawTrendLines(
  ctx: ReturnType<typeof createCanvas>["getContext"],
  candles: QuantCandle[],
  width: number,
  height: number,
) {
  if (candles.length < 4) {
    return;
  }
  const padding = 40;
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const maxPrice = Math.max(...highs);
  const minPrice = Math.min(...lows);
  const barWidth = Math.max(3, (width - padding * 2) / candles.length);

  const recent = candles.slice(-Math.max(6, Math.floor(candles.length / 2)));
  const recentStartIndex = candles.length - recent.length;

  const maxHighIndex = recent.reduce(
    (top, candle, idx) => (candle.high > recent[top].high ? idx : top),
    0,
  );
  const minLowIndex = recent.reduce(
    (bottom, candle, idx) => (candle.low < recent[bottom].low ? idx : bottom),
    0,
  );

  const resistancePoints = [
    { index: recentStartIndex + maxHighIndex, price: recent[maxHighIndex].high },
    { index: candles.length - 1, price: candles[candles.length - 1].high },
  ];

  const supportPoints = [
    { index: recentStartIndex + minLowIndex, price: recent[minLowIndex].low },
    { index: candles.length - 1, price: candles[candles.length - 1].low },
  ];

  const drawLine = (
    points: { index: number; price: number }[],
    color: string,
  ) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((point, idx) => {
      const x = padding + point.index * barWidth + barWidth / 2;
      const y = scalePrice(point.price, minPrice, maxPrice, height, padding);
      if (idx === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  };

  drawLine(resistancePoints, "#ef4444");
  drawLine(supportPoints, "#3b82f6");
}

function createBaseCanvas(width: number, height: number) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#040714";
  ctx.fillRect(0, 0, width, height);

  const grd = ctx.createLinearGradient(0, 0, 0, height);
  grd.addColorStop(0, "rgba(15,23,42,0.8)");
  grd.addColorStop(1, "rgba(3,7,18,0.95)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, width, height);
  return { canvas, ctx };
}

function writeImage(basePath: string, buffer: Buffer) {
  ensureDir(basePath);
  writeFileSync(basePath, buffer);
}

export async function renderQuantImages(
  candles: QuantCandle[],
  context: RenderContext,
): Promise<RenderResult> {
  const { width, height, outputDir, symbol, frame } = context;
  const targetDir = resolve(
    outputDir,
    symbol.toUpperCase(),
    frame,
    new Date().toISOString().split("T")[0],
  );
  const patternPath = resolve(targetDir, "pattern.png");
  const trendPath = resolve(targetDir, "trend.png");

  // Pattern image with pivot markers
  const { canvas: patternCanvas, ctx: patternCtx } = createBaseCanvas(width, height);
  patternCtx.fillStyle = "#f8fafc";
  patternCtx.font = "24px sans-serif";
  patternCtx.fillText(`${symbol} • ${frame} • K线形态`, 40, 32);
  drawCandlesticks(patternCtx, candles, width, height);
  drawPivotMarkers(patternCtx, candles, width, height);
  const patternBuffer = Buffer.from(await patternCanvas.encode("png"));
  writeImage(patternPath, patternBuffer);

  // Trend image with trend lines
  const { canvas: trendCanvas, ctx: trendCtx } = createBaseCanvas(width, height);
  trendCtx.fillStyle = "#f8fafc";
  trendCtx.font = "24px sans-serif";
  trendCtx.fillText(`${symbol} • ${frame} • 趋势线`, 40, 32);
  drawCandlesticks(trendCtx, candles, width, height);
  drawTrendLines(trendCtx, candles, width, height);
  const trendBuffer = Buffer.from(await trendCanvas.encode("png"));
  writeImage(trendPath, trendBuffer);

  logger.debug(`生成量化图像 ${symbol} ${frame} @ ${targetDir}`);

  return {
    patternImagePath: patternPath,
    patternBase64: patternBuffer.toString("base64"),
    trendImagePath: trendPath,
    trendBase64: trendBuffer.toString("base64"),
  };
}
