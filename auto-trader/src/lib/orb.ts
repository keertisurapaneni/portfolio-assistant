/**
 * Opening Range Breakout (ORB) utility
 *
 * Somesh's rule: the first 15 minutes of the session (three 5-min candles at
 * 9:30, 9:35, 9:40 AM ET) define the "opening range."
 *
 *   - Price ABOVE  ORB high → trending up  → OK to trade LONG
 *   - Price BELOW  ORB low  → trending down → OK to trade SHORT
 *   - Price INSIDE the ORB  → choppy        → SKIP the trade
 *
 * Usage:
 *   const orb = await fetchOrb('SPY');
 *   if (orb?.status === 'inside') return 'skipped:inside_orb';
 *
 * The result is cached per ticker for 5 minutes so repeated calls within the
 * same scheduler cycle don't multiply Yahoo Finance requests.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type OrbStatus =
  | 'above'      // current price is above ORB high → uptrend confirmed
  | 'below'      // current price is below ORB low  → downtrend confirmed
  | 'inside'     // current price between ORB low and high → choppy, skip
  | 'not_ready'; // fewer than 3 bars printed yet (before ~9:45 AM ET)

export interface OrbResult {
  high: number;
  low: number;
  status: OrbStatus;
  currentPrice: number;
  barsUsed: number; // how many 5-min bars formed the ORB (should be 3)
}

// ── Cache ─────────────────────────────────────────────────────────────────

interface CacheEntry {
  result: OrbResult;
  fetchedAt: number; // Date.now()
}

const _cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Fetch ─────────────────────────────────────────────────────────────────

/**
 * Fetch the Opening Range (first 15 min) for a ticker and classify
 * where the current price sits relative to it.
 *
 * Returns null on any network or parse failure — callers should proceed
 * (never block a trade solely because ORB data is unavailable).
 *
 * @param symbol  Stock ticker or index (e.g. 'SPY', '^GSPC')
 */
export async function fetchOrb(symbol: string): Promise<OrbResult | null> {
  const cacheKey = symbol.toUpperCase();
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.result;
  }

  try {
    const encoded = encodeURIComponent(symbol);
    // range=1d gives today's session in 5-min bars; includePrePost=false drops pre-market
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=1d&interval=5m&includePrePost=false`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)' },
    });
    if (!res.ok) return null;

    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const q = result.indicators?.quote?.[0] ?? {};
    const highs:  (number | null)[] = q.high  ?? [];
    const lows:   (number | null)[] = q.low   ?? [];
    const closes: (number | null)[] = q.close ?? [];

    // Need at least 1 bar to have any data; classify 'not_ready' if < 3 bars
    const validCount = closes.filter((c: number | null) => c != null).length;
    if (validCount < 1) return null;

    // Opening range: first 3 completed bars (9:30, 9:35, 9:40 AM ET)
    const orbBars = Math.min(3, validCount);
    const orbHighs  = highs.slice(0, orbBars).filter((h): h is number => h != null);
    const orbLows   = lows.slice(0, orbBars).filter((l): l is number => l != null);
    if (orbHighs.length === 0 || orbLows.length === 0) return null;

    const orbHigh = Math.max(...orbHighs);
    const orbLow  = Math.min(...orbLows);

    // Current price = last non-null close
    const currentPrice = [...closes].reverse().find((c): c is number => c != null);
    if (currentPrice == null) return null;

    let status: OrbStatus;
    if (orbBars < 3) {
      status = 'not_ready';
    } else if (currentPrice > orbHigh) {
      status = 'above';
    } else if (currentPrice < orbLow) {
      status = 'below';
    } else {
      status = 'inside';
    }

    const orbResult: OrbResult = { high: orbHigh, low: orbLow, status, currentPrice, barsUsed: orbBars };
    _cache.set(cacheKey, { result: orbResult, fetchedAt: Date.now() });
    return orbResult;
  } catch (err) {
    console.warn(`[ORB] Fetch failed for ${symbol}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Quick helper: returns true when a ticker is inside its ORB and a trade
 * in `direction` should be suppressed.
 *
 * - direction = 'BUY'  → suppress if inside OR below ORB (no bullish momentum)
 * - direction = 'SELL' → suppress if inside OR above ORB (no bearish momentum)
 *
 * Returns false (don't suppress) when ORB data is unavailable, so the gate
 * is never a hard blocker on data failure.
 */
export async function isInsideOrb(symbol: string, direction: 'BUY' | 'SELL'): Promise<boolean> {
  const orb = await fetchOrb(symbol);
  if (!orb || orb.status === 'not_ready') return false; // data missing → don't block

  if (orb.status === 'inside') return true;
  // Also block directional mismatches: don't BUY when below ORB, don't SELL when above ORB
  if (direction === 'BUY'  && orb.status === 'below') return true;
  if (direction === 'SELL' && orb.status === 'above') return true;
  return false;
}
