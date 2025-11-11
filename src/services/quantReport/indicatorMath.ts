import type { QuantCandle } from "./marketData";

function ema(values: number[], period: number): number[] {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];
  let prev = values[0];
  result.push(prev);
  for (let i = 1; i < values.length; i++) {
    const current = values[i] * k + prev * (1 - k);
    result.push(current);
    prev = current;
  }
  return result;
}

export function calcMACD(closes: number[]) {
  if (closes.length < 26) {
    return { macd: 0, signal: 0, histogram: 0 };
  }
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12.map((value, idx) => value - (ema26[idx] ?? value));
  const signal = ema(macdLine.slice(emaLineOffset(macdLine.length)), 9);
  const macd = macdLine[macdLine.length - 1] ?? 0;
  const signalValue = signal[signal.length - 1] ?? 0;
  const histogram = macd - signalValue;
  return { macd, signal: signalValue, histogram };
}

function emaLineOffset(length: number) {
  return Math.max(0, length - Math.floor(length));
}

export function calcRSI(closes: number[], period = 14) {
  if (closes.length < period + 1) {
    return 50;
  }
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) {
      gains += diff;
    } else {
      losses -= diff;
    }
  }
  gains /= period;
  losses /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) {
      gains = (gains * (period - 1) + diff) / period;
      losses = (losses * (period - 1)) / period;
    } else {
      gains = (gains * (period - 1)) / period;
      losses = (losses * (period - 1) - diff) / period;
    }
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function calcROC(closes: number[], period = 12) {
  if (closes.length <= period) return 0;
  const prev = closes[closes.length - period - 1];
  const current = closes[closes.length - 1];
  return ((current - prev) / prev) * 100;
}

export function calcATR(candles: QuantCandle[], period = 14) {
  if (candles.length < period + 1) {
    return 0;
  }
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prev.close),
      Math.abs(current.low - prev.close),
    );
    trs.push(tr);
  }
  const atr = trs.slice(-period).reduce((sum, value) => sum + value, 0) / period;
  return atr;
}

export function summarizeIndicators(candles: QuantCandle[]) {
  const closes = candles.map((candle) => candle.close);
  const macd = calcMACD(closes);
  const rsi = calcRSI(closes);
  const roc = calcROC(closes);
  const atr = calcATR(candles);
  return {
    macd,
    rsi,
    roc,
    atr,
  };
}

function describeMacd(histogram: number, signal: number) {
  if (histogram > 0.001) return `MACD 柱状 ${histogram.toFixed(3)}，动能增强`;
  if (histogram < -0.001) return `MACD 柱状 ${histogram.toFixed(3)}，动能走弱`;
  if (Math.abs(signal) < 0.0005) return "MACD 临近零轴，趋势中性";
  return `MACD 接近平衡（柱状 ${histogram.toFixed(3)}）`;
}

function describeRsi(rsi: number) {
  if (rsi >= 70) return `RSI ${rsi.toFixed(1)}（超买）`;
  if (rsi <= 30) return `RSI ${rsi.toFixed(1)}（超卖）`;
  if (rsi >= 55) return `RSI ${rsi.toFixed(1)}（偏强）`;
  if (rsi <= 45) return `RSI ${rsi.toFixed(1)}（偏弱）`;
  return `RSI ${rsi.toFixed(1)}（中性）`;
}

function describeRoc(roc: number) {
  if (roc >= 1) return `ROC ${roc.toFixed(2)}%，动量上行`;
  if (roc <= -1) return `ROC ${roc.toFixed(2)}%，动量下行`;
  return `ROC ${roc.toFixed(2)}%，动量平稳`;
}

export function buildIndicatorNarrative(candles: QuantCandle[]): string {
  if (!candles.length) {
    return "暂无指标数据。";
  }
  const summary = summarizeIndicators(candles);
  const lastClose = candles[candles.length - 1].close || 1;
  const atrPercent = summary.atr > 0 ? (summary.atr / lastClose) * 100 : 0;

  const lines = [
    `【动量】${describeMacd(summary.macd.histogram, summary.macd.signal)}，ROC ${describeRoc(summary.roc)}`,
    `【振荡】${describeRsi(summary.rsi)}`,
    `【波动】ATR ${summary.atr.toFixed(3)}（约 ${atrPercent.toFixed(2)}% 的日内波动）`,
  ];
  return lines.join("\n");
}
