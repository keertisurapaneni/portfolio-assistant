/**
 * Centralized Finnhub API client with rate limiting and caching.
 *
 * Finnhub free tier allows 60 API calls per minute. This module enforces a
 * global sliding-window rate limiter (55 calls/60s for headroom) so that ALL
 * callers across the auto-trader share the same budget. When the limit is hit,
 * calls wait rather than fail.
 *
 * A short-lived response cache (2-min TTL) avoids redundant API calls when
 * multiple scanners request the same data within a short window.
 */

export const FINNHUB_BASE = 'https://finnhub.io/api/v1';
export const FINNHUB_KEY = process.env.FINNHUB_API_KEY ?? '';

// ── Sliding-window rate limiter (circular buffer) ─────────
//
// Fixed-size Float64Array avoids the O(n) array.shift() that the naive
// approach incurs on every prune. With only 55 slots the perf difference
// is negligible, but this is cleaner and allocation-free after init.

const MAX_REQUESTS = 55;
const WINDOW_MS = 60_000;

const ringBuf = new Float64Array(MAX_REQUESTS);
let head = 0;   // next write position
let count = 0;  // active entries in the window

function oldestIdx(): number {
  return (head - count + MAX_REQUESTS) % MAX_REQUESTS;
}

function pruneOldTimestamps(): void {
  const cutoff = Date.now() - WINDOW_MS;
  while (count > 0 && ringBuf[oldestIdx()]! < cutoff) {
    count--;
  }
}

function recordCall(): void {
  ringBuf[head] = Date.now();
  head = (head + 1) % MAX_REQUESTS;
  if (count < MAX_REQUESTS) count++;
}

async function waitForSlot(): Promise<void> {
  pruneOldTimestamps();
  if (count < MAX_REQUESTS) return;

  const waitMs = ringBuf[oldestIdx()]! + WINDOW_MS - Date.now() + 50;
  if (waitMs > 0) {
    console.log(
      `[Finnhub] Rate limit reached (${count}/${MAX_REQUESTS}), waiting ${waitMs}ms...`,
    );
    await new Promise(r => setTimeout(r, waitMs));
    pruneOldTimestamps();
  }
}

// ── Response cache ────────────────────────────────────────

const CACHE_TTL_MS = 2 * 60_000;
const responseCache = new Map<string, { data: unknown; ts: number }>();

function getCached<T>(url: string): T | undefined {
  const entry = responseCache.get(url);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    responseCache.delete(url);
    return undefined;
  }
  return entry.data as T;
}

function setCache(url: string, data: unknown): void {
  responseCache.set(url, { data, ts: Date.now() });

  if (responseCache.size > 200) {
    const cutoff = Date.now() - CACHE_TTL_MS;
    for (const [key, val] of responseCache) {
      if (val.ts < cutoff) responseCache.delete(key);
    }
  }
}

// ── Retry helpers ─────────────────────────────────────────

const RETRY_DELAY_MS = 500;

function isTransientError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'TimeoutError') return true;
  if (err instanceof TypeError) return true; // fetch network failures
  return false;
}

function isFinnhubErrorBody(data: unknown): boolean {
  return (
    data != null &&
    typeof data === 'object' &&
    'error' in data &&
    typeof (data as Record<string, unknown>).error === 'string'
  );
}

// ── Public API ────────────────────────────────────────────

/**
 * Rate-limited, cached Finnhub API fetch.
 * All Finnhub calls across the auto-trader should go through this function.
 *
 * - Enforces a 55-request/60-second sliding window across ALL callers
 * - Caches successful responses for 2 minutes
 * - Retries once on transient network/timeout errors (not on API errors)
 * - Detects Finnhub's 200-with-error-body pattern and returns null without caching
 * - Returns null on any failure (network, parse, non-200 status)
 */
export async function finnhubFetch<T>(url: string): Promise<T | null> {
  if (!FINNHUB_KEY) return null;

  const cached = getCached<T>(url);
  if (cached !== undefined) return cached;

  let lastErr: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }

    await waitForSlot();
    recordCall();

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(12_000),
      });

      // Non-200: don't retry (server said no), don't cache
      if (!res.ok) return null;

      const data = (await res.json()) as T;

      // Finnhub sometimes returns {"error":"..."} with HTTP 200
      if (isFinnhubErrorBody(data)) return null;

      setCache(url, data);
      return data;
    } catch (err) {
      lastErr = err;
      if (attempt === 0 && isTransientError(err)) continue;
      break;
    }
  }

  if (lastErr) {
    console.warn(`[Finnhub] fetch failed after retry: ${lastErr}`);
  }
  return null;
}
