/**
 * Candlestick Pattern Detection — daily timeframe
 *
 * Detects 6 patterns from daily OHLC bars:
 *   1. Lower wick rejection   (bullish) — buyers defended a level; wick > 2× body
 *   2. Upper wick rejection   (bearish) — sellers rejected a push higher
 *   3. Three-candle momentum  (bullish) — three consecutive higher green closes
 *   4. Bullish engulfing               — large green body swallows previous red body
 *   5. Bearish engulfing               — large red body swallows previous green body
 *   6. Doji breakout / breakdown       — indecision resolved into a strong directional candle
 *
 * Usage in the scheduler:
 *   Applied only to scanner-generated day/swing trade ideas (NOT influencer signals).
 *   Acts as a confidence modifier (+0.5 confirming, -1.0 contradicting), never a hard gate,
 *   except when score = -1 AND adjustedConf drops below minScannerConfidence.
 */

export interface CandleBar {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CandlePatternResult {
  /** -1 = patterns contradict trade direction; 0 = neutral; +1 = patterns confirm direction */
  score: -1 | 0 | 1;
  /** Human-readable pattern names with ✓ (confirming) or ✗ (contradicting) prefix */
  patterns: string[];
  bullishCount: number;
  bearishCount: number;
}

/**
 * Fetch recent daily OHLC candles from Yahoo Finance.
 * Reuses the same base URL as fetchYahooDailyBars — no new API dependencies.
 * Returns null on any failure so callers degrade gracefully.
 */
export async function fetchRecentDailyCandles(symbol: string, days = 10): Promise<CandleBar[] | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d&includePrePost=false`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const q = result.indicators?.quote?.[0] ?? {};

    const opens: (number | null)[]   = q.open  ?? [];
    const highs: (number | null)[]   = q.high  ?? [];
    const lows:  (number | null)[]   = q.low   ?? [];
    const closes:(number | null)[]   = q.close ?? [];

    const candles: CandleBar[] = [];
    for (let i = 0; i < closes.length; i++) {
      const o = opens[i], h = highs[i], l = lows[i], c = closes[i];
      if (o != null && h != null && l != null && c != null) {
        candles.push({ open: o, high: h, low: l, close: c });
      }
    }
    return candles.length >= 3 ? candles.slice(-days) : null;
  } catch {
    return null;
  }
}

/**
 * Detect candlestick patterns and score them against the trade direction.
 *
 * @param candles   Recent daily bars, oldest-first, minimum 3 required.
 * @param direction Trade signal direction — determines if patterns confirm or contradict.
 */
export function detectCandlePatterns(candles: CandleBar[], direction: 'BUY' | 'SELL'): CandlePatternResult {
  if (candles.length < 3) {
    return { score: 0, patterns: [], bullishCount: 0, bearishCount: 0 };
  }

  const bullish: string[] = [];
  const bearish: string[] = [];

  const last  = candles[candles.length - 1];
  const prev  = candles[candles.length - 2];
  const prev2 = candles[candles.length - 3];

  // ── 1. Lower wick rejection (bullish) ─────────────────────────────────
  // Lower wick > 2× body AND close in the upper 70%+ of the candle range.
  // Signals buyers absorbed sell pressure and reclaimed the level.
  {
    const body       = Math.abs(last.close - last.open);
    const lowerWick  = Math.min(last.close, last.open) - last.low;
    const totalRange = last.high - last.low;
    const closeRatio = totalRange > 0 ? (last.close - last.low) / totalRange : 0;
    if (body > 0 && lowerWick > body * 2 && closeRatio > 0.7) {
      bullish.push('lower wick rejection');
    }
  }

  // ── 2. Upper wick rejection (bearish) ─────────────────────────────────
  // Upper wick > 2× body AND close in the lower 30% of the range.
  // Signals sellers absorbed buying pressure and pushed price back down.
  {
    const body       = Math.abs(last.close - last.open);
    const upperWick  = last.high - Math.max(last.close, last.open);
    const totalRange = last.high - last.low;
    const closeRatio = totalRange > 0 ? (last.close - last.low) / totalRange : 0;
    if (body > 0 && upperWick > body * 2 && closeRatio < 0.3) {
      bearish.push('upper wick rejection');
    }
  }

  // ── 3. Three-candle bullish momentum ──────────────────────────────────
  // Three consecutive higher closes, all green bodies (close > open).
  // Buyers are winning consistently — momentum trade confirmation.
  {
    const c1 = candles[candles.length - 3];
    const c2 = candles[candles.length - 2];
    const c3 = candles[candles.length - 1];
    if (
      c1.close > c1.open && c2.close > c2.open && c3.close > c3.open &&
      c2.close > c1.close && c3.close > c2.close
    ) {
      bullish.push('three-candle momentum');
    }
  }

  // ── 4. Bullish engulfing ───────────────────────────────────────────────
  // Previous candle is red; current is green AND its body fully engulfs the previous body.
  // One side just took complete control — strong reversal/continuation signal.
  {
    const prevRed   = prev.close < prev.open;
    const currGreen = last.close > last.open;
    // Body open of current < body close of prev AND body close of current > body open of prev
    const engulfs   = last.open <= prev.close && last.close >= prev.open;
    if (prevRed && currGreen && engulfs) {
      bullish.push('bullish engulfing');
    }
  }

  // ── 5. Bearish engulfing ───────────────────────────────────────────────
  {
    const prevGreen = prev.close > prev.open;
    const currRed   = last.close < last.open;
    const engulfs   = last.open >= prev.close && last.close <= prev.open;
    if (prevGreen && currRed && engulfs) {
      bearish.push('bearish engulfing');
    }
  }

  // ── 6. Doji breakout / breakdown ──────────────────────────────────────
  // Previous candle is a doji (tiny body ≤ 10% of range) — market indecision.
  // Current candle is large (body > 60% of range) and closes beyond the doji's extreme.
  // The market has picked a side and is expanding rapidly.
  {
    const prevRange = prev.high - prev.low;
    const prevBody  = Math.abs(prev.close - prev.open);
    const isDoji    = prevRange > 0 && prevBody / prevRange < 0.1;

    if (isDoji) {
      const currRange = last.high - last.low;
      const currBody  = Math.abs(last.close - last.open);
      const isLarge   = currRange > 0 && currBody / currRange > 0.6;

      if (isLarge && last.close > last.open && last.close > prev.high) {
        bullish.push('doji breakout');
      } else if (isLarge && last.close < last.open && last.close < prev.low) {
        bearish.push('doji breakdown');
      }
    }
  }

  // ── Score ─────────────────────────────────────────────────────────────
  const confirming   = direction === 'BUY' ? bullish : bearish;
  const contradicting = direction === 'BUY' ? bearish : bullish;

  // Build human-readable list with direction markers
  const patterns = [
    ...confirming.map(p => `✓ ${p}`),
    ...contradicting.map(p => `✗ ${p}`),
  ];

  let score: -1 | 0 | 1 = 0;
  if (contradicting.length > 0 && confirming.length === 0) {
    score = -1;
  } else if (confirming.length > 0) {
    score = 1;
  }

  return { score, patterns, bullishCount: bullish.length, bearishCount: bearish.length };
}
