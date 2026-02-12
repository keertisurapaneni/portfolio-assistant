/**
 * Shared data fetchers — used by both trading-signals (full analysis)
 * and trade-scanner (batch scan).
 *
 * All use Yahoo Finance (no API key needed) so they work in any edge function.
 */

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Referer: 'https://finance.yahoo.com/',
};

// ── Yahoo Finance news ──────────────────────────────────

export interface NewsHeadline {
  headline: string;
  source: string;
}

export async function fetchYahooNews(symbol: string): Promise<NewsHeadline[]> {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=8`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data?.news || !Array.isArray(data.news)) return [];
    return data.news
      .slice(0, 5)
      .map((item: { title?: string; publisher?: string }) => ({
        headline: item.title ?? '',
        source: item.publisher ?? 'Yahoo',
      }))
      .filter((n: NewsHeadline) => n.headline.length > 0);
  } catch {
    return [];
  }
}

// ── Yahoo v7 batch quote (fundamentals + earnings date) ──

export interface FundamentalSnapshot {
  trailingPE: number | null;
  forwardPE: number | null;
  epsTrailing: number | null;
  earningsDate: string | null;
  daysToEarnings: number | null;
  analystRating: string | null;
}

export async function fetchFundamentalsBatch(symbols: string[]): Promise<Map<string, FundamentalSnapshot>> {
  const map = new Map<string, FundamentalSnapshot>();
  if (symbols.length === 0) return map;
  try {
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(',')}&fields=trailingPE,forwardPE,epsTrailingTwelveMonths,earningsTimestamp,averageAnalystRating`;
    const res = await fetch(url, {
      headers: YAHOO_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return map;
    const data = await res.json();
    const quotes = data?.quoteResponse?.result ?? [];
    const now = Date.now();
    for (const q of quotes) {
      const sym = q.symbol;
      if (!sym) continue;
      const earningsTs = q.earningsTimestamp ? q.earningsTimestamp * 1000 : null;
      const daysToEarnings = earningsTs ? Math.round((earningsTs - now) / (1000 * 60 * 60 * 24)) : null;
      map.set(sym, {
        trailingPE: q.trailingPE ?? null,
        forwardPE: q.forwardPE ?? null,
        epsTrailing: q.epsTrailingTwelveMonths ?? null,
        earningsDate: earningsTs ? new Date(earningsTs).toISOString().slice(0, 10) : null,
        daysToEarnings,
        analystRating: q.averageAnalystRating ?? null,
      });
    }
  } catch (e) {
    console.warn('[Shared] Fundamentals batch fetch failed:', e);
  }
  return map;
}

// ── Market context (SPY + VIX via Yahoo) ────────────────

export interface MarketContext {
  spyTrend: string;
  vixLevel: string;
}

export async function fetchMarketContext(): Promise<MarketContext | null> {
  try {
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=SPY,%5EVIX&fields=regularMarketPrice,fiftyDayAverage`;
    const res = await fetch(url, {
      headers: YAHOO_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const quotes: Record<string, number>[] = data?.quoteResponse?.result ?? [];
    const spy = quotes.find((q: Record<string, unknown>) => q.symbol === 'SPY');
    const vix = quotes.find((q: Record<string, unknown>) => q.symbol === '^VIX');
    if (!spy || !vix) return null;

    const spyPrice = spy.regularMarketPrice ?? 0;
    const spySma50 = spy.fiftyDayAverage ?? 0;
    const spyTrend = spySma50 > 0
      ? (spyPrice > spySma50
        ? `Bullish (SPY $${spyPrice.toFixed(0)} above SMA50 $${spySma50.toFixed(0)})`
        : `Bearish (SPY $${spyPrice.toFixed(0)} below SMA50 $${spySma50.toFixed(0)})`)
      : `SPY $${spyPrice.toFixed(0)}`;

    const vixPrice = vix.regularMarketPrice ?? 0;
    const vixLabel = vixPrice < 15 ? 'Low fear' : vixPrice < 20 ? 'Moderate' : vixPrice < 30 ? 'High fear' : 'Extreme fear';
    const vixLevel = `${vixPrice.toFixed(1)} (${vixLabel})`;

    return { spyTrend, vixLevel };
  } catch {
    return null;
  }
}

// ── Yahoo v8 candle fetcher (unified source for all functions) ──

/**
 * Candle format matching what the indicator engine and AI prompts expect.
 * String values + newest-first order (same as Twelve Data's original format).
 */
export interface Candle {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

// Map from FA interval names to Yahoo interval + appropriate range
const INTERVAL_MAP: Record<string, { yahooInterval: string; defaultRange: string; aggregate4h?: boolean }> = {
  '1min':  { yahooInterval: '1m',  defaultRange: '7d' },
  '5min':  { yahooInterval: '5m',  defaultRange: '60d' },
  '15min': { yahooInterval: '15m', defaultRange: '60d' },
  '1h':    { yahooInterval: '1h',  defaultRange: '60d' },
  '4h':    { yahooInterval: '1h',  defaultRange: '730d', aggregate4h: true }, // Yahoo has no 4h — fetch 1h, aggregate
  '1day':  { yahooInterval: '1d',  defaultRange: '3y' },
  '1week': { yahooInterval: '1wk', defaultRange: '10y' },
  // Scanner uses these names
  '1m':    { yahooInterval: '1m',  defaultRange: '7d' },
  '5m':    { yahooInterval: '5m',  defaultRange: '60d' },
  '15m':   { yahooInterval: '15m', defaultRange: '60d' },
  '1d':    { yahooInterval: '1d',  defaultRange: '3y' },
  '1wk':   { yahooInterval: '1wk', defaultRange: '10y' },
};

/**
 * Fetch OHLCV candles from Yahoo Finance v8 chart API.
 * Returns newest-first (like Twelve Data) with string values.
 * Optionally limit to `outputsize` most recent candles.
 */
export async function fetchCandles(
  symbol: string,
  interval: string,
  outputsize = 150,
  rangeOverride?: string,
): Promise<{ values: Candle[] } | null> {
  const mapping = INTERVAL_MAP[interval];
  if (!mapping) {
    console.warn(`[Shared] Unknown interval: ${interval}`);
    return null;
  }

  const range = rangeOverride ?? mapping.defaultRange;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${mapping.yahooInterval}&includePrePost=false`;

  try {
    const res = await fetch(url, {
      headers: YAHOO_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn(`[Shared] Yahoo chart ${res.status} for ${symbol} ${interval}`);
      return null;
    }
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result?.timestamp?.length) return null;

    const timestamps: number[] = result.timestamp;
    const q = result.indicators?.quote?.[0] ?? {};
    const opens: (number | null)[] = q.open ?? [];
    const highs: (number | null)[] = q.high ?? [];
    const lows: (number | null)[] = q.low ?? [];
    const closes: (number | null)[] = q.close ?? [];
    const volumes: (number | null)[] = q.volume ?? [];

    const isDaily = mapping.yahooInterval === '1d' || mapping.yahooInterval === '1wk';
    const candles: Candle[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      if (opens[i] == null || closes[i] == null) continue;
      const dt = new Date(timestamps[i] * 1000);
      let datetime: string;
      if (isDaily) {
        // "2026-02-12" format
        datetime = dt.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
      } else {
        // "2026-02-12 14:30:00" format
        const d = dt.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        const t = dt.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false });
        datetime = `${d} ${t}`;
      }
      candles.push({
        datetime,
        open: opens[i]!.toFixed(4),
        high: (highs[i] ?? opens[i]!).toFixed(4),
        low: (lows[i] ?? opens[i]!).toFixed(4),
        close: closes[i]!.toFixed(4),
        volume: String(volumes[i] ?? 0),
      });
    }

    // Yahoo returns oldest-first; reverse to newest-first
    candles.reverse();

    // If 4h requested, aggregate 1h → 4h
    let final = candles;
    if (mapping.aggregate4h) {
      final = aggregate1hTo4h(candles);
    }

    // Limit to requested outputsize
    const limited = final.slice(0, outputsize);

    return { values: limited };
  } catch (e) {
    console.warn(`[Shared] Yahoo chart failed for ${symbol} ${interval}:`, e);
    return null;
  }
}

/**
 * Market snapshot: SPY trend + VIX level.
 * Full version with bias/volatility fields (used by FA's indicator formatter).
 */
export interface MarketSnapshot {
  bias: string;
  volatility: string;
  spyTrend: string;
  vix: number;
}

export async function fetchMarketSnapshot(): Promise<MarketSnapshot | null> {
  try {
    // Fetch SPY daily candles to compute SMA50
    const spyData = await fetchCandles('SPY', '1day', 60);
    if (!spyData?.values?.length) return null;

    const spyPrice = parseFloat(spyData.values[0].close);
    const len = Math.min(50, spyData.values.length);
    let sma50 = 0;
    for (let i = 0; i < len; i++) sma50 += parseFloat(spyData.values[i].close);
    sma50 /= len;

    // Fetch VIX
    const vixUrl = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=%5EVIX&fields=regularMarketPrice`;
    const vixRes = await fetch(vixUrl, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(8_000) });
    let vixClose = 20; // default
    if (vixRes.ok) {
      const vixData = await vixRes.json();
      const vq = vixData?.quoteResponse?.result?.[0];
      if (vq?.regularMarketPrice) vixClose = vq.regularMarketPrice;
    }

    const spyTrend = spyPrice > sma50 ? 'Bullish (above SMA50)' : 'Bearish (below SMA50)';
    const bias = spyPrice > sma50 ? 'Bullish' : 'Bearish';
    let volatility: string;
    if (vixClose < 15) volatility = 'Low';
    else if (vixClose < 20) volatility = 'Moderate';
    else if (vixClose < 30) volatility = 'High';
    else volatility = 'Extreme';

    return { bias, volatility, spyTrend, vix: Math.round(vixClose * 10) / 10 };
  } catch (e) {
    console.warn('[Shared] Market snapshot fetch failed:', e);
    return null;
  }
}

// ── Aggregate 1h candles into 4h candles ────────────────
// Yahoo doesn't support 4h natively, so we fetch 1h and aggregate.

export function aggregate1hTo4h(candles: Candle[]): Candle[] {
  if (candles.length === 0) return [];

  // Candles come in newest-first. Reverse to oldest-first for grouping.
  const oldest = [...candles].reverse();

  // Group into 4h blocks based on market hours: 9:30-13:30, 13:30-16:00
  // (two 4h-ish blocks per trading day)
  const groups: Candle[][] = [];
  let currentGroup: Candle[] = [];
  let currentBlock = '';

  for (const c of oldest) {
    // Extract hour from datetime "2026-02-12 10:00:00"
    const timePart = c.datetime.split(' ')[1] ?? '';
    const hour = parseInt(timePart.split(':')[0] ?? '0', 10);
    const datePart = c.datetime.split(' ')[0];
    const block = hour < 14 ? `${datePart}-AM` : `${datePart}-PM`;

    if (block !== currentBlock && currentGroup.length > 0) {
      groups.push(currentGroup);
      currentGroup = [];
    }
    currentBlock = block;
    currentGroup.push(c);
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  // Aggregate each group into one 4h candle
  const result: Candle[] = groups.map(group => {
    const open = parseFloat(group[0].open);
    let high = -Infinity, low = Infinity;
    let vol = 0;
    for (const c of group) {
      const h = parseFloat(c.high), l = parseFloat(c.low);
      if (h > high) high = h;
      if (l < low) low = l;
      vol += parseInt(c.volume ?? '0', 10);
    }
    const close = parseFloat(group[group.length - 1].close);
    return {
      datetime: group[0].datetime, // Use first candle's time as the block timestamp
      open: open.toFixed(4),
      high: high.toFixed(4),
      low: low.toFixed(4),
      close: close.toFixed(4),
      volume: String(vol),
    };
  });

  // Reverse back to newest-first
  result.reverse();
  return result;
}

// ── Format helpers ──────────────────────────────────────

export function formatFundamentalsForAI(f: FundamentalSnapshot): string {
  const parts: string[] = [];
  if (f.trailingPE != null) parts.push(`P/E: ${f.trailingPE.toFixed(1)}`);
  if (f.forwardPE != null) parts.push(`Fwd P/E: ${f.forwardPE.toFixed(1)}`);
  if (f.analystRating) parts.push(`Analyst: ${f.analystRating}`);
  if (f.daysToEarnings != null) {
    if (f.daysToEarnings <= 0) parts.push(`⚠️ EARNINGS JUST REPORTED`);
    else if (f.daysToEarnings <= 3) parts.push(`⚠️ EARNINGS IN ${f.daysToEarnings} DAY(S) — high binary risk`);
    else if (f.daysToEarnings <= 7) parts.push(`⚠️ Earnings in ${f.daysToEarnings} days`);
    else if (f.daysToEarnings <= 14) parts.push(`Earnings in ${f.daysToEarnings} days`);
  }
  return parts.length > 0 ? parts.join(' | ') : '';
}

export function formatNewsForAI(headlines: NewsHeadline[]): string {
  if (headlines.length === 0) return 'No recent news';
  return headlines.map(n => `- "${n.headline}" (${n.source})`).join('\n');
}
