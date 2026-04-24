/**
 * Yahoo Finance helpers for the auto-trader.
 *
 * Replaces Finnhub's paid `stock/candle` and `stock/metric` endpoints with
 * free Yahoo Finance APIs that work for every ticker without an API key.
 *
 * Used by:
 *   - options-scanner.ts  (trend, dip/BB, range-bound, SMA200, beta, 52w high)
 *   - options-chain.ts    (IV estimation via historical volatility)
 *   - dip-watcher.ts      (daily candles)
 *   - earnings-scanner.ts (daily candles)
 */

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)',
  Accept: 'application/json',
};

const TIMEOUT_MS = 12_000;

// ── Core candle fetcher ──────────────────────────────────────────────────────

export interface DailyBar {
  date: string;       // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Fetch daily OHLCV bars from Yahoo Finance v8 chart API.
 * Returns oldest-first (chronological). Never throws — returns null on failure.
 *
 * @param symbol  Ticker symbol (e.g. "AAPL", "^VIX")
 * @param range   Yahoo range string: "1mo" | "3mo" | "6mo" | "1y" | "2y"
 */
export async function fetchDailyBars(symbol: string, range: string): Promise<DailyBar[] | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&includePrePost=false`;
    const res = await fetch(url, {
      headers: YAHOO_HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const data = await res.json() as Record<string, unknown>;
    const result = (data?.chart as Record<string, unknown>)?.result as Record<string, unknown>[] | undefined;
    if (!result?.[0]) return null;

    const r = result[0];
    const timestamps = r.timestamp as number[] | undefined;
    if (!timestamps?.length) return null;

    const q = ((r.indicators as Record<string, unknown>)?.quote as Record<string, unknown>[])?.[0] ?? {};
    const opens   = (q.open   as (number | null)[]) ?? [];
    const highs   = (q.high   as (number | null)[]) ?? [];
    const lows    = (q.low    as (number | null)[]) ?? [];
    const closes  = (q.close  as (number | null)[]) ?? [];
    const volumes = (q.volume as (number | null)[]) ?? [];

    const bars: DailyBar[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (c == null) continue;
      const dt = new Date(timestamps[i] * 1000);
      bars.push({
        date:   dt.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
        open:   opens[i]   ?? c,
        high:   highs[i]   ?? c,
        low:    lows[i]    ?? c,
        close:  c,
        volume: volumes[i] ?? 0,
      });
    }
    return bars; // oldest-first
  } catch {
    return null;
  }
}

// ── Convenience extractors ───────────────────────────────────────────────────

/** Last N closing prices, oldest-first. Returns [] if insufficient data. */
export async function fetchClosePrices(symbol: string, days: number): Promise<number[]> {
  const range = days <= 30 ? '2mo' : days <= 90 ? '6mo' : days <= 200 ? '1y' : '2y';
  const bars = await fetchDailyBars(symbol, range);
  if (!bars || bars.length < Math.min(days, 20)) return [];
  return bars.map(b => b.close).slice(-days);
}

/** Last N bars with full OHLCV, oldest-first. */
export async function fetchOHLCV(symbol: string, days: number): Promise<DailyBar[]> {
  const range = days <= 30 ? '2mo' : days <= 90 ? '6mo' : days <= 252 ? '1y' : '2y';
  const bars = await fetchDailyBars(symbol, range);
  if (!bars) return [];
  return bars.slice(-days);
}

// ── SMA helper ───────────────────────────────────────────────────────────────

/** Compute the N-period simple moving average of the last N values. */
export function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ── Stock quote (price + beta + 52w high) ───────────────────────────────────

export interface YahooQuote {
  price:        number;
  beta:         number | null;
  high52w:      number | null;
  earningsTs:   number | null;  // Unix ms, next earnings
}

/**
 * Fetch live quote data for one symbol via Yahoo Finance v7.
 * Returns price, beta, 52-week high, and next earnings timestamp.
 * No API key required. Returns null on failure.
 */
export async function fetchQuote(symbol: string): Promise<YahooQuote | null> {
  try {
    const fields = 'regularMarketPrice,beta,fiftyTwoWeekHigh,earningsTimestamp';
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}&fields=${fields}`;
    const res = await fetch(url, {
      headers: YAHOO_HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    const quotes = ((data?.quoteResponse as Record<string, unknown>)?.result as Record<string, unknown>[]) ?? [];
    const q = quotes.find((r: Record<string, unknown>) => r.symbol === symbol) ?? quotes[0];
    if (!q) return null;
    const price = q.regularMarketPrice as number | undefined;
    if (!price) return null;
    return {
      price,
      beta:       (q.beta       as number | undefined) ?? null,
      high52w:    (q.fiftyTwoWeekHigh as number | undefined) ?? null,
      earningsTs: (q.earningsTimestamp as number | undefined)
                    ? (q.earningsTimestamp as number) * 1000
                    : null,
    };
  } catch {
    return null;
  }
}

// ── Annualised historical volatility (proxy for IV) ──────────────────────────

/**
 * Estimate annualised implied volatility from 30-day realised volatility.
 * Applies a 1.2× vol-risk-premium scalar, clamped to [15%, 150%].
 * Falls back to 30% if insufficient data.
 */
export async function estimateHistoricalVol(symbol: string): Promise<number> {
  const closes = await fetchClosePrices(symbol, 60);
  if (closes.length < 20) return 0.30;
  const sample = closes.slice(-31);
  const returns = sample.slice(1).map((c, i) => Math.log(c / sample[i]));
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const hv = Math.sqrt(variance * 252);
  return Math.min(Math.max(hv * 1.2, 0.15), 1.50);
}
