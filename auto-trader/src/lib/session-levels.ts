/**
 * Session Levels — Pre-market high/low and RTH high/low for any ticker.
 *
 * Fetches 1-minute bars from Yahoo Finance with includePrePost=true,
 * filters bars before 9:30 AM ET to extract pre-market high/low.
 * RTH high/low covers bars from 9:30 AM ET onward.
 *
 * Cache: in-memory Map per ticker, reset at midnight ET.
 */

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)',
  Accept: 'application/json',
};

const TIMEOUT_MS = 12_000;

export interface SessionLevels {
  preMarketHigh: number | null;
  preMarketLow: number | null;
  rthHigh: number | null;
  rthLow: number | null;
}

interface CacheEntry {
  levels: SessionLevels;
  fetchedAt: number;
}

const _cache = new Map<string, CacheEntry>();
let _lastResetDate = '';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — PM levels are fixed after open; RTH drifts

function getEtDateString(): string {
  return new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function resetCacheIfNewDay(): void {
  const today = getEtDateString();
  if (today !== _lastResetDate) {
    _cache.clear();
    _lastResetDate = today;
  }
}

/**
 * Fetch pre-market and RTH session levels for a ticker.
 * Pre-market bars: before 9:30 AM ET. RTH bars: 9:30 AM ET onward.
 * Returns null fields on data failure — callers degrade gracefully.
 */
export async function fetchSessionLevels(ticker: string): Promise<SessionLevels> {
  resetCacheIfNewDay();

  const key = ticker.toUpperCase();
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.levels;
  }

  const empty: SessionLevels = {
    preMarketHigh: null,
    preMarketLow: null,
    rthHigh: null,
    rthLow: null,
  };

  try {
    const encoded = encodeURIComponent(ticker);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=1d&interval=1m&includePrePost=true`;
    const res = await fetch(url, {
      headers: YAHOO_HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[SessionLevels] Yahoo fetch failed for ${ticker}: ${res.status}`);
      return empty;
    }

    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return empty;

    const timestamps: number[] = result.timestamp ?? [];
    const q = result.indicators?.quote?.[0] ?? {};
    const highs: (number | null)[] = q.high ?? [];
    const lows: (number | null)[] = q.low ?? [];

    // 9:30 AM ET in epoch: compute today's 9:30 AM ET timestamp
    const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const rthOpenMs = new Date(
      etNow.getFullYear(),
      etNow.getMonth(),
      etNow.getDate(),
      9, 30, 0,
    ).getTime();
    // Convert to epoch seconds, adjusting for ET offset
    // Use the actual timestamps to determine which are pre-market vs RTH
    const rthOpenEpoch = rthOpenMs / 1000;

    // Yahoo timestamps are in UTC epoch seconds. We need to figure out
    // the ET offset from the first timestamp to properly split PM vs RTH.
    // Simpler: convert each timestamp to ET hours and compare.
    let pmHigh = -Infinity;
    let pmLow = Infinity;
    let rthHigh = -Infinity;
    let rthLow = Infinity;
    let pmCount = 0;
    let rthCount = 0;

    for (let i = 0; i < timestamps.length; i++) {
      const h = highs[i];
      const l = lows[i];
      if (h == null || l == null) continue;

      const barDate = new Date(timestamps[i] * 1000);
      const etStr = barDate.toLocaleString('en-US', { timeZone: 'America/New_York' });
      const etTime = new Date(etStr);
      const etMinutes = etTime.getHours() * 60 + etTime.getMinutes();

      if (etMinutes < 9 * 60 + 30) {
        // Pre-market bar
        if (h > pmHigh) pmHigh = h;
        if (l < pmLow) pmLow = l;
        pmCount++;
      } else {
        // RTH bar
        if (h > rthHigh) rthHigh = h;
        if (l < rthLow) rthLow = l;
        rthCount++;
      }
    }

    const levels: SessionLevels = {
      preMarketHigh: pmCount > 0 && pmHigh > -Infinity ? pmHigh : null,
      preMarketLow: pmCount > 0 && pmLow < Infinity ? pmLow : null,
      rthHigh: rthCount > 0 && rthHigh > -Infinity ? rthHigh : null,
      rthLow: rthCount > 0 && rthLow < Infinity ? rthLow : null,
    };

    _cache.set(key, { levels, fetchedAt: Date.now() });

    if (pmCount > 0) {
      console.log(
        `[SessionLevels] ${ticker}: PMH=$${levels.preMarketHigh?.toFixed(2)} PML=$${levels.preMarketLow?.toFixed(2)} ` +
        `(${pmCount} PM bars), RTH H=$${levels.rthHigh?.toFixed(2)} L=$${levels.rthLow?.toFixed(2)} (${rthCount} bars)`,
      );
    }

    return levels;
  } catch (err) {
    console.warn(`[SessionLevels] Error fetching ${ticker}:`, err instanceof Error ? err.message : err);
    return empty;
  }
}
