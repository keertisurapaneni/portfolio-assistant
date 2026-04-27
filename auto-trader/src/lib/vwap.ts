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
 * Usage in the auto-trader:
 *   As a confidence MODIFIER on day trades (not a signal or hard gate).
 *   Adds +0.3 confidence when price is near VWAP and trade direction is aligned.
 *   Logs a warning (non-blocking) when price is far from VWAP in the wrong direction.
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
  let cumTPV = 0;  // cumulative typical-price × volume
  let cumVol = 0;  // cumulative volume

  for (let i = 0; i < closes.length; i++) {
    const h = highs[i], l = lows[i], c = closes[i], v = volumes[i];
    if (h == null || l == null || c == null || v == null || v <= 0) continue;
    const tp = (h + l + c) / 3;
    cumTPV += tp * v;
    cumVol += v;
  }

  return cumVol > 0 ? cumTPV / cumVol : null;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Fetch today's 5-min bars and compute the current session VWAP.
 *
 * Returns null on any failure — callers must degrade gracefully.
 *
 * @param symbol  Stock or ETF ticker (e.g. 'SPY', 'QQQ')
 */
export async function fetchVwap(symbol: string): Promise<VwapResult | null> {
  const cacheKey = symbol.toUpperCase();
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.result;
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

    // Filter to only completed bars with full data
    const h: number[] = [], l: number[] = [], c: number[] = [], v: number[] = [];
    for (let i = 0; i < closes.length; i++) {
      if (highs[i] != null && lows[i] != null && closes[i] != null && (volumes[i] ?? 0) > 0) {
        h.push(highs[i]!); l.push(lows[i]!); c.push(closes[i]!); v.push(volumes[i]!);
      }
    }

    if (h.length < 3) return null; // not enough data

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
  } catch (err) {
    console.warn(`[VWAP] Fetch failed for ${symbol}:`, err instanceof Error ? err.message : err);
    return null;
  }
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
): Promise<{ delta: number; log: string }> {
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
    // Price is far away AND on the wrong side — log as a mild caution but don't block
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
