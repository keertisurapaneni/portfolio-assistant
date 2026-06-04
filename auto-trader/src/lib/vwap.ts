/**
 * VWAP (Volume Weighted Average Price) utility
 *
 * Somesh's rules:
 *   - VWAP = cumulative (H+L+C)/3 × volume ÷ cumulative volume, anchored to session open
 *   - Institutions BUY at or near VWAP (benchmarked against it — can't justify paying above average)
 *   - Institutions SELL at or near VWAP (won't undercut their exit price)
 *   - VWAP acts as dynamic support (trending up) or dynamic resistance (trending down)
 *   - Entry: price comes TO VWAP, bounces/retests → trade in the direction of the bounce
 *   - ⚠️  Only reliable AFTER 10:00 AM ET — before that, insufficient volume for institutional anchoring
 *
 * VWAP Reclaim strategy (Somesh's chop-exit signal):
 *   When the market is choppy (inside ORB), wait for:
 *   1. One 5-min candle to close above VWAP (the "reclaim")
 *   2. The next candle to dip back toward VWAP (the "retest")
 *   3. Enter long at the retest, stop below VWAP, target hourly levels
 *   Mirror logic applies for shorts (breakdown below VWAP + retest from above).
 *
 * Usage in the auto-trader:
 *   1. Confidence MODIFIER on day trades (+0.3 when near VWAP and aligned).
 *   2. Chop-exit gate: when ORB says "inside" (choppy), detectVwapReclaim()
 *      can override the block if VWAP was just reclaimed — turning chop into an entry.
 *   Always a no-op before 10 AM ET and on data failure.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface VwapResult {
  vwap: number;          // current VWAP value
  currentPrice: number;  // last traded price (final close bar)
  distancePct: number;   // (currentPrice - vwap) / vwap × 100 (positive = price above VWAP)
  side: 'above' | 'below' | 'at'; // where price sits relative to VWAP
  isNear: boolean;       // price within NEAR_THRESHOLD_PCT of VWAP
  barsUsed: number;      // number of 5-min bars used (data quality indicator)
}

export interface VwapReclaimResult {
  reclaimed: boolean;     // true = chop is ending, VWAP was reclaimed in the direction we want
  direction: 'BUY' | 'SELL';
  vwap: number;
  currentPrice: number;
  log: string;            // human-readable explanation
}

// ── Constants ─────────────────────────────────────────────────────────────

/** Price is "near VWAP" when within this % distance */
const NEAR_THRESHOLD_PCT = 0.5;

/** VWAP is only reliable after this ET hour (10 AM) */
export const VWAP_RELIABLE_HOUR_ET = 10;

// ── Cache ─────────────────────────────────────────────────────────────────

interface CacheEntry {
  result: VwapResult;
  fetchedAt: number;
}

const _cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 3 * 60 * 1000; // 3-min TTL — VWAP drifts throughout the session

interface RawBars {
  h: number[]; l: number[]; c: number[]; v: number[];
}

interface RawBarsCacheEntry {
  bars: RawBars;
  fetchedAt: number;
}

const _rawBarsCache = new Map<string, RawBarsCacheEntry>();

// ── Core computation ───────────────────────────────────────────────────────

/**
 * Compute session-anchored VWAP from intraday 5-min bars.
 * Formula: VWAP = Σ(typical_price × volume) / Σ(volume)
 * where typical_price = (high + low + close) / 3
 */
function computeVwap(
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[],
): number | null {
  let cumTPV = 0;
  let cumVol = 0;

  for (let i = 0; i < closes.length; i++) {
    const h = highs[i], l = lows[i], c = closes[i], v = volumes[i];
    if (h == null || l == null || c == null || v == null || v <= 0) continue;
    const tp = (h + l + c) / 3;
    cumTPV += tp * v;
    cumVol += v;
  }

  return cumVol > 0 ? cumTPV / cumVol : null;
}

/**
 * Compute progressive (rolling) VWAP at each bar — returns the VWAP value
 * as it would have been at the close of each 5-min bar.
 */
function computeProgressiveVwap(
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[],
): number[] {
  const vwaps: number[] = [];
  let cumTPV = 0;
  let cumVol = 0;

  for (let i = 0; i < closes.length; i++) {
    const h = highs[i], l = lows[i], c = closes[i], v = volumes[i];
    if (h == null || l == null || c == null || v == null || v <= 0) {
      vwaps.push(cumVol > 0 ? cumTPV / cumVol : 0);
      continue;
    }
    const tp = (h + l + c) / 3;
    cumTPV += tp * v;
    cumVol += v;
    vwaps.push(cumTPV / cumVol);
  }

  return vwaps;
}

// ── Raw bar fetcher (shared by fetchVwap + detectVwapReclaim) ─────────────

async function fetchRawBars(symbol: string): Promise<RawBars | null> {
  const cacheKey = symbol.toUpperCase();
  const cached = _rawBarsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.bars;
  }

  try {
    const encoded = encodeURIComponent(symbol);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=1d&interval=5m&includePrePost=false`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)' },
    });
    if (!res.ok) return null;

    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const q = result.indicators?.quote?.[0] ?? {};
    const highs:   (number | null)[] = q.high   ?? [];
    const lows:    (number | null)[] = q.low    ?? [];
    const closes:  (number | null)[] = q.close  ?? [];
    const volumes: (number | null)[] = q.volume ?? [];

    const h: number[] = [], l: number[] = [], c: number[] = [], v: number[] = [];
    for (let i = 0; i < closes.length; i++) {
      if (highs[i] != null && lows[i] != null && closes[i] != null && (volumes[i] ?? 0) > 0) {
        h.push(highs[i]!); l.push(lows[i]!); c.push(closes[i]!); v.push(volumes[i]!);
      }
    }

    if (h.length < 3) return null;

    const bars: RawBars = { h, l, c, v };
    _rawBarsCache.set(cacheKey, { bars, fetchedAt: Date.now() });
    return bars;
  } catch (err) {
    console.warn(`[VWAP] Fetch failed for ${symbol}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Fetch today's 5-min bars and compute the current session VWAP.
 *
 * Returns null on any failure — callers must degrade gracefully.
 */
export async function fetchVwap(symbol: string): Promise<VwapResult | null> {
  const cacheKey = symbol.toUpperCase();
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.result;
  }

  const bars = await fetchRawBars(symbol);
  if (!bars) return null;

  const { h, l, c, v } = bars;
  const vwap = computeVwap(h, l, c, v);
  if (vwap == null || vwap <= 0) return null;

  const currentPrice = c[c.length - 1];
  const distancePct = parseFloat((((currentPrice - vwap) / vwap) * 100).toFixed(3));
  const absDistance = Math.abs(distancePct);

  const side: VwapResult['side'] =
    absDistance < 0.05 ? 'at' :
    distancePct > 0    ? 'above' : 'below';

  const vwapResult: VwapResult = {
    vwap: parseFloat(vwap.toFixed(2)),
    currentPrice,
    distancePct,
    side,
    isNear: absDistance <= NEAR_THRESHOLD_PCT,
    barsUsed: h.length,
  };

  _cache.set(cacheKey, { result: vwapResult, fetchedAt: Date.now() });
  return vwapResult;
}

/**
 * Detect VWAP reclaim/breakdown — Somesh's chop-exit signal.
 *
 * Scans the last few 5-min bars for a state transition:
 *   BUY reclaim:  a candle closed above VWAP after the prior candle closed below/at VWAP,
 *                 and the current bar is pulling back toward VWAP (retest)
 *   SELL breakdown: mirror — candle closed below VWAP after the prior closed above/at
 *
 * The "retest" condition is relaxed: the current price just needs to be within 0.6% of VWAP
 * (i.e. pulling back toward it, not running away). This catches the "next candle dips" pattern
 * without requiring the price to touch VWAP exactly.
 *
 * Returns { reclaimed: false } on any data failure — never blocks.
 */
export async function detectVwapReclaim(
  symbol: string,
  direction: 'BUY' | 'SELL',
): Promise<VwapReclaimResult> {
  const fail = (log: string): VwapReclaimResult => ({
    reclaimed: false, direction, vwap: 0, currentPrice: 0, log,
  });

  const bars = await fetchRawBars(symbol);
  if (!bars || bars.c.length < 6) return fail('VWAP reclaim: insufficient bars');

  const { h, l, c, v } = bars;
  const vwaps = computeProgressiveVwap(h, l, c, v);
  const n = c.length;

  // We need at least the last 4 bars to detect a crossover + retest:
  // bar[n-4], bar[n-3] = "before" period, bar[n-2] = crossover candle, bar[n-1] = current/retest
  const LOOKBACK = 4;
  if (n < LOOKBACK) return fail('VWAP reclaim: not enough bars for crossover detection');

  const currentPrice = c[n - 1];
  const currentVwap = vwaps[n - 1];
  if (!currentVwap || currentVwap <= 0) return fail('VWAP reclaim: invalid VWAP');

  // Scan the last few bars for a crossover event
  // A "reclaim" for BUY: bar[i-1] closed <= VWAP, bar[i] closed > VWAP
  // A "breakdown" for SELL: bar[i-1] closed >= VWAP, bar[i] closed < VWAP
  let crossoverFound = false;
  let crossoverBarIdx = -1;

  for (let i = n - 1; i >= n - LOOKBACK && i >= 1; i--) {
    const prevClose = c[i - 1];
    const prevVwap = vwaps[i - 1];
    const currClose = c[i];
    const currVwap = vwaps[i];
    if (!prevVwap || !currVwap) continue;

    if (direction === 'BUY' && prevClose <= prevVwap && currClose > currVwap) {
      crossoverFound = true;
      crossoverBarIdx = i;
      break;
    }
    if (direction === 'SELL' && prevClose >= prevVwap && currClose < currVwap) {
      crossoverFound = true;
      crossoverBarIdx = i;
      break;
    }
  }

  if (!crossoverFound) {
    return fail(`VWAP reclaim: no ${direction === 'BUY' ? 'bullish' : 'bearish'} crossover in last ${LOOKBACK} bars`);
  }

  // Retest condition: current price pulling back toward VWAP (within 0.6%)
  // For BUY: price should still be above VWAP but close to it (dipping back)
  // For SELL: price should still be below VWAP but close to it
  const distPct = Math.abs(((currentPrice - currentVwap) / currentVwap) * 100);
  const RETEST_THRESHOLD = 0.6;

  const priceOnCorrectSide =
    (direction === 'BUY'  && currentPrice >= currentVwap) ||
    (direction === 'SELL' && currentPrice <= currentVwap);

  // Accept the reclaim if:
  // 1. The crossover candle IS the current candle (just happened), OR
  // 2. Price is on the correct side and near VWAP (retest pattern)
  const isCurrentBar = crossoverBarIdx === n - 1;
  const isRetesting = priceOnCorrectSide && distPct <= RETEST_THRESHOLD;

  if (isCurrentBar || isRetesting) {
    return {
      reclaimed: true,
      direction,
      vwap: parseFloat(currentVwap.toFixed(2)),
      currentPrice,
      log: `VWAP ${direction === 'BUY' ? 'reclaim' : 'breakdown'}: ` +
        `${isCurrentBar ? 'crossover this bar' : `retest at ${distPct.toFixed(2)}% from VWAP`} — ` +
        `price $${currentPrice.toFixed(2)} vs VWAP $${currentVwap.toFixed(2)}`,
    };
  }

  return fail(
    `VWAP reclaim: crossover found ${n - 1 - crossoverBarIdx} bars ago but ` +
    `price ${distPct.toFixed(2)}% from VWAP (${priceOnCorrectSide ? 'correct side but too far' : 'wrong side'})`,
  );
}

/**
 * Evaluate VWAP alignment for a trade direction.
 *
 * Returns a confidence delta (+0.3, 0, or -0 with a warning log string).
 * Always returns 0 before 10 AM ET or on data failure.
 *
 * Alignment logic (based on Somesh's institutional flow rationale):
 *   BUY:  Ideal entry is AT or just BELOW VWAP (buying near/at average price)
 *         Price far ABOVE VWAP = institutions already paid up; edge reduced
 *   SELL: Ideal entry is AT or just ABOVE VWAP (selling near/at average price)
 *         Price far BELOW VWAP = institutions already dumped; edge reduced
 *
 * @returns { delta: number, log: string }
 *   delta — confidence adjustment to apply (+0.3 = aligned and near, 0 = neutral/missing)
 *   log   — human-readable reason for the adjustment
 */
export async function evaluateVwapAlignment(
  symbol: string,
  direction: 'BUY' | 'SELL',
  etHour: number,
): Promise<{ delta: number; log: string; block?: boolean }> {
  // Hard rule: VWAP not reliable before 10 AM ET
  if (etHour < VWAP_RELIABLE_HOUR_ET) {
    return { delta: 0, log: 'VWAP: pre-10AM, skipped' };
  }

  const vwap = await fetchVwap(symbol);
  if (!vwap) {
    return { delta: 0, log: 'VWAP: data unavailable, skipped' };
  }

  const { side, isNear, distancePct, vwap: vwapPrice } = vwap;

  // Near VWAP + aligned direction → bullish confirmation
  if (isNear) {
    return {
      delta: 0.3,
      log: `VWAP: price $${vwap.currentPrice} near VWAP $${vwapPrice} (${distancePct > 0 ? '+' : ''}${distancePct}%) — aligned entry`,
    };
  }

  // Price far from VWAP — check directional alignment
  const aligned =
    (direction === 'BUY'  && side !== 'above') ||  // not expensive relative to VWAP
    (direction === 'SELL' && side !== 'below');     // not already discounted

  if (!aligned) {
    // Price is on the wrong side of VWAP relative to trade direction.
    // If extended >5%: hard block — no intraday edge left (confirmed: ARM was +4.5% above
    // VWAP on a BUY, trade drifted lower all session, so we need headroom above 4.5%).
    // 3% was too tight — AVGO (+3.0%) and ARM (+3.4%) on 2026-06-04 were winners that
    // the 3% gate killed. Raised to 5% to allow momentum continuation setups where
    // the 4H trend is confirmed and price is running with it (not against it).
    const absDistancePct = Math.abs(distancePct);
    if (absDistancePct > 5.0) {
      return {
        delta: 0,
        block: true,
        log: `VWAP: ${direction} but price ${distancePct > 0 ? '+' : ''}${distancePct}% ${side} VWAP $${vwapPrice} — too extended, blocking`,
      };
    }
    return {
      delta: 0,
      log: `VWAP: ${direction} but price ${distancePct > 0 ? '+' : ''}${distancePct}% ${side} VWAP $${vwapPrice} — reduced edge, proceeding`,
    };
  }

  return {
    delta: 0,
    log: `VWAP: ${distancePct > 0 ? '+' : ''}${distancePct}% from $${vwapPrice} — not at level yet, neutral`,
  };
}
