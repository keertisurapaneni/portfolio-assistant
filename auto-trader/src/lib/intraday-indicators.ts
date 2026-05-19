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
