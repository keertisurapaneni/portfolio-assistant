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

// ── Sliding-window rate limiter ──────────────────────────

const MAX_REQUESTS = 55;
const WINDOW_MS = 60_000;
const callTimestamps: number[] = [];

function pruneOldTimestamps(): void {
  const cutoff = Date.now() - WINDOW_MS;
  while (callTimestamps.length > 0 && callTimestamps[0]! < cutoff) {
    callTimestamps.shift();
  }
}

async function waitForSlot(): Promise<void> {
  pruneOldTimestamps();
  if (callTimestamps.length < MAX_REQUESTS) return;

  const oldestTs = callTimestamps[0]!;
  const waitMs = oldestTs + WINDOW_MS - Date.now() + 50;
  if (waitMs > 0) {
    console.log(
      `[Finnhub] Rate limit reached (${callTimestamps.length}/${MAX_REQUESTS}), waiting ${waitMs}ms...`,
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

// ── Public API ────────────────────────────────────────────

/**
 * Rate-limited, cached Finnhub API fetch.
 * All Finnhub calls across the auto-trader should go through this function.
 *
 * - Enforces a 55-request/60-second sliding window across ALL callers
 * - Caches responses for 2 minutes to avoid redundant API calls
 * - Returns null on any failure (network, parse, non-200 status)
 */
export async function finnhubFetch<T>(url: string): Promise<T | null> {
  if (!FINNHUB_KEY) return null;

  const cached = getCached<T>(url);
  if (cached !== undefined) return cached;

  await waitForSlot();
  callTimestamps.push(Date.now());

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as T;
    setCache(url, data);
    return data;
  } catch {
    return null;
  }
}
