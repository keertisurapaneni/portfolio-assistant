/**
 * Intraday Indicators — EMA and ATR computation on 5-minute bars.
 *
 * Used by the VWAP confluence and Fibonacci retracement scanners.
 * All inputs are oldest-first arrays.
 */

/**
 * Compute EMA series over closing prices (oldest-first in, oldest-first out).
 * Returns an array of the same length as input. Values before `period` are NaN
 * (insufficient data). The first valid EMA is seeded with SMA of the first
 * `period` values.
 */
export function computeEMA(closes: number[], period: number): number[] {
  const result: number[] = [];
  if (closes.length < period) {
    return closes.map(() => NaN);
  }

  const k = 2 / (period + 1);

  // Seed: SMA of first `period` values
  let prev = 0;
  for (let i = 0; i < period; i++) prev += closes[i];
  prev /= period;

  // Fill initial slots with NaN
  for (let i = 0; i < period - 1; i++) result.push(NaN);
  result.push(prev);

  // Walk forward
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    result.push(prev);
  }

  return result;
}

/**
 * Compute the latest EMA value (single number, not full series).
 * Returns NaN if insufficient data.
 */
export function computeEMALatest(closes: number[], period: number): number {
  if (closes.length < period) return NaN;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += closes[i];
  prev /= period;
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
  }
  return prev;
}

/**
 * Compute Average Directional Index (ADX) over OHLC bars (oldest-first).
 * Uses Wilder's smoothing. Returns the latest ADX value.
 * Returns NaN if insufficient data (needs 2*period + 1 bars).
 *
 * ADX > 25 = trending market. ADX < 20 = weak/no trend.
 */
export function computeADX(
  bars: { high: number; low: number; close: number }[],
  period = 14,
): number {
  if (bars.length < 2 * period + 1) return NaN;

  const trValues: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    trValues.push(tr);

    const upMove = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  let smoothTR = 0, smoothPlusDM = 0, smoothMinusDM = 0;
  for (let i = 0; i < period; i++) {
    smoothTR += trValues[i];
    smoothPlusDM += plusDM[i];
    smoothMinusDM += minusDM[i];
  }

  const dxValues: number[] = [];
  for (let i = period; i < trValues.length; i++) {
    smoothTR = smoothTR - smoothTR / period + trValues[i];
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];

    const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    dxValues.push(diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0);
  }

  if (dxValues.length < period) return NaN;

  let adx = 0;
  for (let i = 0; i < period; i++) adx += dxValues[i];
  adx /= period;

  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period;
  }

  return adx;
}

/**
 * Compute Average True Range over OHLC bars (oldest-first).
 * Uses Wilder's smoothing (exponential). Returns the latest ATR value.
 * Returns NaN if insufficient data.
 */
export function computeATR(
  bars: { high: number; low: number; close: number }[],
  period: number,
): number {
  if (bars.length < period + 1) return NaN;

  // True Range for each bar (starting from index 1 — needs previous close)
  const trValues: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high;
    const l = bars[i].low;
    const pc = bars[i - 1].close;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    trValues.push(tr);
  }

  if (trValues.length < period) return NaN;

  // Initial ATR = SMA of first `period` true ranges
  let atr = 0;
  for (let i = 0; i < period; i++) atr += trValues[i];
  atr /= period;

  // Wilder's smoothing
  for (let i = period; i < trValues.length; i++) {
    atr = (atr * (period - 1) + trValues[i]) / period;
  }

  return atr;
}
