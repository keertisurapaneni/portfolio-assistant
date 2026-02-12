/**
 * Shared analysis pipeline — used by both trading-signals (full analysis)
 * and trade-scanner (Pass 2 refinement).
 *
 * This ensures both see the EXACT SAME indicators, candle data, and formatting,
 * eliminating signal mismatches caused by different analysis code.
 */

import {
  type OHLCV,
  type IndicatorSummary,
  computeAllIndicators,
  formatIndicatorsForPrompt,
} from './indicators.ts';
import {
  type Candle,
  type MarketSnapshot,
  type NewsHeadline,
  fetchCandles,
  fetchMarketSnapshot,
  fetchYahooNews,
} from './data-fetchers.ts';

// ── Types ────────────────────────────────────────────────

export type Mode = 'DAY_TRADE' | 'SWING_TRADE';

export interface AnalysisContext {
  indicators: IndicatorSummary;
  indicatorText: string;                           // formatIndicatorsForPrompt output
  candles: Record<string, { values: Candle[] }>;   // all timeframes (full data)
  trimmedCandles: Record<string, unknown>;          // last 40 per TF, for AI prompt
  currentPrice: number | null;
  marketSnapshot: MarketSnapshot | null;
  news: NewsHeadline[];
  ohlcvBars: OHLCV[];                              // raw bars used for indicators
}

// ── Constants (single source of truth) ───────────────────

/** Candle timeframes per mode — same for scanner Pass 2 AND full analysis. */
export const MODE_INTERVALS: Record<Mode, [string, string, string]> = {
  DAY_TRADE: ['1min', '15min', '1h'],
  SWING_TRADE: ['4h', '1day', '1week'],
};

/** How many candles to fetch per timeframe (full analysis — includes 2.5yr daily history). */
export const CANDLE_SIZES: Record<string, number> = {
  '1min': 150, '15min': 150, '1h': 150,
  '4h': 250, '1day': 600, '1week': 150,
};

/** Lighter candle sizes for scanner Pass 2 — enough for all indicators (SMA200 needs ~210) + validation. */
const CANDLE_SIZES_LITE: Record<string, number> = {
  '1min': 60, '15min': 60, '1h': 60,
  '4h': 60, '1day': 250, '1week': 60,
};

/** Which timeframe to use for indicator computation. */
const INDICATOR_INTERVAL: Record<Mode, string> = {
  DAY_TRADE: '15min',
  SWING_TRADE: '1day',
};

// ── Core function ────────────────────────────────────────

/**
 * Prepare the full analysis context for a ticker.
 * Both the scanner (Pass 2) and full analysis call this,
 * guaranteeing identical data and indicators.
 *
 * @param lite  When true, fetches fewer candles to conserve compute (scanner mode).
 *              The indicators + AI prompt are identical; only the raw history depth differs.
 *
 * Returns null if insufficient candle data is available.
 */
export async function prepareAnalysisContext(
  ticker: string,
  mode: Mode,
  lite = false,
): Promise<AnalysisContext | null> {
  const intervals = MODE_INTERVALS[mode];
  const sizes = lite ? CANDLE_SIZES_LITE : CANDLE_SIZES;

  // ── Fetch candles + market snapshot + news in parallel ──
  const candlePromises = intervals.map(int =>
    fetchCandles(ticker, int, sizes[int] ?? 150)
  );
  const newsPromise = fetchYahooNews(ticker);
  const marketPromise = fetchMarketSnapshot();

  const [candles1, candles2, candles3, news, marketSnapshot] = await Promise.all([
    ...candlePromises,
    newsPromise,
    marketPromise,
  ]);

  // Build timeframes map
  const timeframes: Record<string, { values: Candle[] }> = {};
  if (candles1?.values) timeframes[intervals[0]] = candles1;
  if (candles2?.values) timeframes[intervals[1]] = candles2;
  if (candles3?.values) timeframes[intervals[2]] = candles3;

  if (Object.keys(timeframes).length === 0) return null;

  // ── Compute indicators from the primary timeframe ──
  const indicatorInterval = INDICATOR_INTERVAL[mode];
  const indicatorCandles = timeframes[indicatorInterval]?.values ?? timeframes[intervals[0]]?.values ?? [];
  const ohlcvBars: OHLCV[] = indicatorCandles.map(v => ({
    o: parseFloat(v.open),
    h: parseFloat(v.high),
    l: parseFloat(v.low),
    c: parseFloat(v.close),
    v: v.volume ? parseFloat(v.volume) : 0,
  }));

  if (ohlcvBars.length < 30) return null; // Not enough data for meaningful indicators

  const indicators: IndicatorSummary = computeAllIndicators(ohlcvBars);

  // ── Current price from primary entry timeframe ──
  const primaryInterval = intervals[0]; // 1min for day, 4h for swing
  const primaryCandles = timeframes[primaryInterval]?.values;
  let currentPrice: number | null = null;
  if (primaryCandles?.length) {
    const c = parseFloat(primaryCandles[0].close);
    if (!Number.isNaN(c)) currentPrice = c;
  }

  // ── Format indicator summary for AI ──
  const marketCtxStr = marketSnapshot
    ? `SPY: ${marketSnapshot.spyTrend} | VIX: ${marketSnapshot.vix} (${marketSnapshot.volatility} fear)`
    : undefined;
  const indicatorText = currentPrice
    ? formatIndicatorsForPrompt(indicators, currentPrice, marketCtxStr)
    : '';

  // ── Trim candle data for AI prompt (last 40 per timeframe) ──
  const trimmedCandles: Record<string, unknown> = {};
  for (const [tf, data] of Object.entries(timeframes)) {
    trimmedCandles[tf] = data.values.slice(0, 40).map(v => ({
      t: v.datetime,
      o: parseFloat(v.open),
      h: parseFloat(v.high),
      l: parseFloat(v.low),
      c: parseFloat(v.close),
      v: v.volume ? parseFloat(v.volume) : 0,
    }));
  }

  return {
    indicators,
    indicatorText,
    candles: timeframes,
    trimmedCandles,
    currentPrice,
    marketSnapshot,
    news,
    ohlcvBars,
  };
}
