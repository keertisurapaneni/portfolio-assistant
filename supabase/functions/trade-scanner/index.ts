// Portfolio Assistant — Trade Scanner Edge Function (v3)
//
// Architecture (two-pass):
//   1. DISCOVERY  — Yahoo Finance screener finds movers (free, fast)
//   2. PASS 1     — Gemini AI batch-evaluates candidates on indicators (quick filter)
//   3. PASS 2     — Top picks get intraday/daily candle data, AI re-evaluates with
//                   price action (mirrors full analysis quality)
//   4. CACHING    — Results stored in Supabase DB, shared across ALL users
//
// Refresh cadence:
//   Day trades:   every 30 min during market hours (9:30 AM – 4:00 PM ET)
//   Swing trades:  2x/day (near open ~10:00 AM, near close ~3:45 PM ET)
//   Outside hours: serve from DB, no refresh
//
// Returns { dayTrades, swingTrades, timestamp, cached }

import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  DAY_TRADE_SYSTEM,
  DAY_TRADE_RULES,
  SWING_TRADE_SYSTEM,
  SWING_TRADE_RULES,
} from '../_shared/prompts.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ── Types ───────────────────────────────────────────────

interface TradeIdea {
  ticker: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  signal: 'BUY' | 'SELL';
  confidence: number;     // 0-10 from AI (matches full analysis scale)
  reason: string;         // AI-generated 1-sentence rationale
  tags: string[];
  mode: 'DAY_TRADE' | 'SWING_TRADE';
}

interface ScanResult {
  dayTrades: TradeIdea[];
  swingTrades: TradeIdea[];
  timestamp: number;
  cached?: boolean;
}

interface YahooQuote {
  symbol: string;
  shortName?: string;
  longName?: string;
  regularMarketPrice: number | { raw: number };
  regularMarketChange: number | { raw: number };
  regularMarketChangePercent: number | { raw: number };
  regularMarketVolume: number | { raw: number };
  averageDailyVolume10Day?: number | { raw: number };
  regularMarketDayHigh?: number | { raw: number };
  regularMarketDayLow?: number | { raw: number };
  regularMarketOpen?: number | { raw: number };
  regularMarketPreviousClose?: number | { raw: number };
  fiftyTwoWeekHigh?: number | { raw: number };
  fiftyTwoWeekLow?: number | { raw: number };
  fiftyDayAverage?: number | { raw: number };
  twoHundredDayAverage?: number | { raw: number };
  marketCap?: number | { raw: number };
  // Computed indicators (populated from chart data)
  _indicators?: Indicators;
}

// AI response shape for one stock
interface AIEval {
  ticker: string;
  signal: 'BUY' | 'SELL' | 'SKIP';
  confidence: number;  // 0-10
  reason: string;
}

// ── Curated swing universe ──────────────────────────────

const SWING_UNIVERSE = [
  // Mega-cap tech
  'AAPL', 'MSFT', 'NVDA', 'GOOG', 'AMZN', 'META', 'TSLA', 'AVGO', 'ORCL', 'CRM',
  'ADBE', 'AMD', 'NFLX', 'INTC', 'QCOM', 'AMAT', 'MU',
  // Finance
  'JPM', 'V', 'MA', 'BAC', 'GS',
  // Healthcare
  'UNH', 'LLY', 'JNJ', 'ABBV', 'MRK', 'PFE',
  // Consumer
  'COST', 'WMT', 'HD', 'NKE', 'MCD', 'SBUX',
  // Industrial & Energy
  'CAT', 'BA', 'GE', 'XOM', 'CVX',
  // Growth & trending
  'COIN', 'PLTR', 'SOFI', 'SNOW', 'SHOP', 'SQ', 'ROKU', 'NET', 'CRWD', 'PANW',
];

// ── Helpers ─────────────────────────────────────────────

function rawVal(v: number | { raw: number } | undefined | null): number {
  if (v == null) return 0;
  return typeof v === 'object' ? v.raw : v;
}

function round(n: number, d = 2): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

// ── Technical Indicators (lightweight, computed from daily closes) ───

interface Indicators {
  rsi14: number | null;
  macdHistogram: number | null;
  sma20: number | null;
  atr14: number | null;
}

function computeRSI(closes: number[], period = 14): number | null {
  // closes = oldest-first
  if (closes.length < period + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return round(100 - 100 / (1 + avgGain / avgLoss), 1);
}

function computeMACDHistogram(closes: number[], fast = 12, slow = 26, sig = 9): number | null {
  // closes = oldest-first
  if (closes.length < slow + sig) return null;
  const ema = (data: number[], p: number): number[] => {
    const k = 2 / (p + 1);
    const out: number[] = [];
    let prev = data.slice(0, p).reduce((a, b) => a + b, 0) / p;
    for (let i = 0; i < p - 1; i++) out.push(NaN);
    out.push(prev);
    for (let i = p; i < data.length; i++) { prev = data[i] * k + prev * (1 - k); out.push(prev); }
    return out;
  };
  const fastE = ema(closes, fast);
  const slowE = ema(closes, slow);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(isNaN(fastE[i]) || isNaN(slowE[i]) ? NaN : fastE[i] - slowE[i]);
  }
  const validMacd = macdLine.filter(v => !isNaN(v));
  if (validMacd.length < sig) return null;
  const k2 = 2 / (sig + 1);
  let sigVal = validMacd.slice(0, sig).reduce((a, b) => a + b, 0) / sig;
  for (let i = sig; i < validMacd.length; i++) sigVal = validMacd[i] * k2 + sigVal * (1 - k2);
  return round(validMacd[validMacd.length - 1] - sigVal, 3);
}

function computeATR(highs: number[], lows: number[], closes: number[], period = 14): number | null {
  // all oldest-first
  if (closes.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  if (trs.length < period) return null;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return round(atr, 2);
}

function computeIndicators(
  closes: number[], highs: number[], lows: number[],
): Indicators {
  // All arrays should be oldest-first
  return {
    rsi14: computeRSI(closes),
    macdHistogram: computeMACDHistogram(closes),
    sma20: closes.length >= 20 ? round(closes.slice(-20).reduce((a, b) => a + b, 0) / 20, 2) : null,
    atr14: computeATR(highs, lows, closes),
  };
}

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Referer: 'https://finance.yahoo.com/',
};

// ── Market hours check (ET) ─────────────────────────────

function getETNow(): { hour: number; minute: number; dayOfWeek: number } {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return { hour: et.getHours(), minute: et.getMinutes(), dayOfWeek: et.getDay() };
}

function isMarketOpen(): boolean {
  const { hour, minute, dayOfWeek } = getETNow();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false; // weekend
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins <= 16 * 60; // 9:30 AM – 4:00 PM ET
}

function isSwingRefreshWindow(): boolean {
  const { hour, minute, dayOfWeek } = getETNow();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const mins = hour * 60 + minute;
  // Near open: 9:45 – 10:15 AM ET
  // Near close: 3:30 – 4:00 PM ET
  return (mins >= 9 * 60 + 45 && mins <= 10 * 60 + 15) ||
         (mins >= 15 * 60 + 30 && mins <= 16 * 60);
}

// ── Yahoo Finance data fetchers ─────────────────────────

async function fetchMovers(type: 'day_gainers' | 'day_losers'): Promise<YahooQuote[]> {
  try {
    const url = new URL('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved');
    url.searchParams.set('formatted', 'false');
    url.searchParams.set('scrIds', type);
    url.searchParams.set('start', '0');
    url.searchParams.set('count', '25');
    url.searchParams.set('lang', 'en-US');
    url.searchParams.set('region', 'US');
    const res = await fetch(url.toString(), { headers: YAHOO_HEADERS });
    if (!res.ok) return [];
    const data = await res.json();
    return data?.finance?.result?.[0]?.quotes ?? [];
  } catch {
    return [];
  }
}

async function fetchChartQuote(symbol: string): Promise<YahooQuote | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&includePrePost=false`;
    const res = await fetch(url, { headers: YAHOO_HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta ?? {};
    const quotes = result.indicators?.quote?.[0] ?? {};
    const closes: (number | null)[] = quotes.close ?? [];
    const volumes: (number | null)[] = quotes.volume ?? [];
    const validCloses = closes.filter((c): c is number => c != null);
    const validVolumes = volumes.filter((v): v is number => v != null);

    const sma50 = validCloses.length >= 50
      ? validCloses.slice(-50).reduce((a, b) => a + b, 0) / 50 : 0;
    const sma200 = validCloses.length >= 200
      ? validCloses.slice(-200).reduce((a, b) => a + b, 0) / 200 : 0;
    const avgVol10 = validVolumes.length >= 10
      ? validVolumes.slice(-10).reduce((a, b) => a + b, 0) / 10 : 0;

    const price = meta.regularMarketPrice ?? 0;
    const prevClose = meta.chartPreviousClose ?? (validCloses.length >= 2 ? validCloses[validCloses.length - 2] : 0);

    // Compute technical indicators from OHLCV history (oldest-first)
    const rawHighs = (quotes.high ?? []).filter((h: number | null): h is number => h != null);
    const rawLows = (quotes.low ?? []).filter((l: number | null): l is number => l != null);
    const indicators = computeIndicators(validCloses, rawHighs, rawLows);

    return {
      symbol: meta.symbol ?? symbol,
      shortName: meta.shortName,
      longName: meta.longName,
      regularMarketPrice: price,
      regularMarketChange: prevClose > 0 ? price - prevClose : 0,
      regularMarketChangePercent: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
      regularMarketVolume: meta.regularMarketVolume ?? (validVolumes.length > 0 ? validVolumes[validVolumes.length - 1] : 0),
      averageDailyVolume10Day: avgVol10,
      regularMarketDayHigh: meta.regularMarketDayHigh ?? 0,
      regularMarketDayLow: meta.regularMarketDayLow ?? 0,
      regularMarketOpen: validCloses.length > 0 ? (quotes.open ?? [])[closes.length - 1] ?? 0 : 0,
      regularMarketPreviousClose: prevClose,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? 0,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? 0,
      fiftyDayAverage: sma50,
      twoHundredDayAverage: sma200,
      _indicators: indicators,
    };
  } catch (e) {
    console.warn(`[Trade Scanner] Chart fetch failed for ${symbol}:`, e);
    return null;
  }
}

async function fetchSwingQuotes(symbols: string[]): Promise<YahooQuote[]> {
  if (symbols.length === 0) return [];
  const BATCH = 10;
  const results: YahooQuote[] = [];
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const res = await Promise.all(batch.map(fetchChartQuote));
    for (const q of res) { if (q) results.push(q); }
  }
  return results;
}

// ── Intraday candle fetcher (Yahoo v8, 5m bars) ─────────
// Used in second-pass refinement for top picks only (~5-6 stocks).

interface IntradayCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function fetchCandleData(
  symbol: string,
  interval = '5m',
  range = '1d',
): Promise<IntradayCandle[]> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
    const res = await fetch(url, { headers: YAHOO_HEADERS });
    if (!res.ok) return [];
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return [];

    const timestamps: number[] = result.timestamp ?? [];
    const quotes = result.indicators?.quote?.[0] ?? {};
    const opens: (number | null)[] = quotes.open ?? [];
    const highs: (number | null)[] = quotes.high ?? [];
    const lows: (number | null)[] = quotes.low ?? [];
    const closes: (number | null)[] = quotes.close ?? [];
    const volumes: (number | null)[] = quotes.volume ?? [];

    const isDaily = interval === '1d' || interval === '1wk';

    const candles: IntradayCandle[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (opens[i] == null || closes[i] == null) continue;
      const dt = new Date(timestamps[i] * 1000);
      let label: string;
      if (isDaily) {
        // Daily/weekly: show date like "Feb 10"
        label = dt.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
      } else {
        // Intraday: show time like "09:35"
        label = dt.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
      }
      candles.push({
        time: label,
        open: round(opens[i]!),
        high: round(highs[i] ?? opens[i]!),
        low: round(lows[i] ?? opens[i]!),
        close: round(closes[i]!),
        volume: volumes[i] ?? 0,
      });
    }
    return candles;
  } catch (e) {
    console.warn(`[Trade Scanner] Candle fetch failed for ${symbol} (${interval}/${range}):`, e);
    return [];
  }
}

function formatCandlesCompact(candles: IntradayCandle[], maxCandles = 40): string {
  if (candles.length === 0) return 'No intraday candles available.';
  const recent = candles.slice(-maxCandles);
  const lines = recent.map(c => {
    const volK = c.volume >= 1_000_000
      ? `${(c.volume / 1_000_000).toFixed(1)}M`
      : `${Math.round(c.volume / 1000)}K`;
    return `${c.time} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${volK}`;
  });
  return lines.join('\n');
}

// ── Format stock data for AI prompt ─────────────────────

function formatQuoteForAI(q: YahooQuote, idx: number): string {
  const price = rawVal(q.regularMarketPrice);
  const changePct = rawVal(q.regularMarketChangePercent);
  const volume = rawVal(q.regularMarketVolume);
  const avgVol = rawVal(q.averageDailyVolume10Day);
  const volRatio = avgVol > 0 ? round(volume / avgVol, 1) : 0;
  const sma50 = rawVal(q.fiftyDayAverage);
  const sma200 = rawVal(q.twoHundredDayAverage);
  const high52 = rawVal(q.fiftyTwoWeekHigh);
  const low52 = rawVal(q.fiftyTwoWeekLow);
  const high = rawVal(q.regularMarketDayHigh);
  const low = rawVal(q.regularMarketDayLow);
  const open = rawVal(q.regularMarketOpen);
  const prevClose = rawVal(q.regularMarketPreviousClose);
  const ind = q._indicators;

  const parts = [
    `${idx + 1}. ${q.symbol} ($${round(price)})`,
    `Chg: ${changePct >= 0 ? '+' : ''}${round(changePct, 1)}%`,
    `Vol: ${(volume / 1e6).toFixed(1)}M (${volRatio}x avg)`,
  ];

  if (high > 0 && low > 0) {
    const rangePct = round(((high - low) / price) * 100, 1);
    parts.push(`Range: $${round(low)}-$${round(high)} (${rangePct}%)`);
  }
  if (open > 0 && prevClose > 0) {
    const gapPct = round(((open - prevClose) / prevClose) * 100, 1);
    if (Math.abs(gapPct) > 1) parts.push(`Gap: ${gapPct > 0 ? '+' : ''}${gapPct}%`);
  }

  // Technical indicators (critical for matching full analysis)
  if (ind) {
    if (ind.rsi14 !== null) {
      const rsiLabel = ind.rsi14 >= 70 ? ' (overbought)' : ind.rsi14 <= 30 ? ' (oversold)' : '';
      parts.push(`RSI(14): ${ind.rsi14}${rsiLabel}`);
    }
    if (ind.macdHistogram !== null) {
      parts.push(`MACD hist: ${ind.macdHistogram > 0 ? '+' : ''}${ind.macdHistogram} (${ind.macdHistogram > 0 ? 'bullish' : 'bearish'})`);
    }
    if (ind.sma20 !== null) {
      parts.push(`SMA20: $${ind.sma20} (${price > ind.sma20 ? 'above' : 'below'})`);
    }
    if (ind.atr14 !== null) {
      const atrPct = round((ind.atr14 / price) * 100, 1);
      parts.push(`ATR: $${ind.atr14} (${atrPct}%)`);
    }
  }

  if (sma50 > 0) parts.push(`SMA50: $${round(sma50)} (${price > sma50 ? 'above' : 'below'})`);
  if (sma200 > 0) parts.push(`SMA200: $${round(sma200)} (${price > sma200 ? 'above' : 'below'})`);
  if (high52 > 0 && low52 > 0 && high52 > low52) {
    const pos52 = round(((price - low52) / (high52 - low52)) * 100, 0);
    parts.push(`52w: ${pos52}% (L:$${round(low52)} H:$${round(high52)})`);
  }

  return parts.join(' | ');
}

// ── Gemini AI ───────────────────────────────────────────

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODELS = ['gemini-2.0-flash-lite', 'gemini-2.0-flash', 'gemini-2.5-flash'];

let _geminiKeyIdx = 0;
let _geminiModelIdx = 0;
const _rateLimitedUntil: Map<string, number> = new Map();

async function callGemini(
  apiKeys: string[],
  systemPrompt: string,
  userPrompt: string,
  temperature = 0.15,
  maxOutputTokens = 2000,
): Promise<string> {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { temperature, maxOutputTokens, thinkingConfig: { thinkingBudget: 0 } },
  });

  let lastResponse: Response | null = null;
  const keyStart = _geminiKeyIdx % apiKeys.length;
  _geminiKeyIdx++;
  const modelStart = _geminiModelIdx % GEMINI_MODELS.length;
  _geminiModelIdx++;
  const now = Date.now();

  for (let m = 0; m < GEMINI_MODELS.length; m++) {
    const mi = (modelStart + m) % GEMINI_MODELS.length;
    const model = GEMINI_MODELS[mi];
    for (let i = 0; i < apiKeys.length; i++) {
      const ki = (keyStart + i) % apiKeys.length;
      const combo = `${mi}:${ki}`;
      const until = _rateLimitedUntil.get(combo);
      if (until && now < until) continue;

      const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKeys[ki]}`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(45_000),
        });
        if (res.ok) {
          const data = await res.json();
          return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        }
        lastResponse = res;
        if (res.status === 429) {
          const ra = res.headers.get('retry-after');
          const ms = ra && !isNaN(Number(ra)) ? Math.min(Number(ra) * 1000, 120_000) : 60_000;
          _rateLimitedUntil.set(combo, Date.now() + ms);
          continue;
        }
        break;
      } catch {
        continue;
      }
    }
  }

  // Cleanup expired cooldowns
  const cn = Date.now();
  for (const [k, v] of _rateLimitedUntil) { if (cn > v) _rateLimitedUntil.delete(k); }

  const errText = lastResponse ? await lastResponse.text().catch(() => '') : '';
  throw new Error(`Gemini failed (exhausted): ${lastResponse?.status ?? '?'} ${errText.slice(0, 200)}`);
}

function cleanJson(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json?\s*/g, '')
    .replace(/```/g, '')
    .trim();
}

// ── AI prompts (all use shared rules from _shared/prompts.ts) ────
// Pass 1: Quick batch scan with indicators only (no candles).
// Pass 2: Refine top picks with candle data using the SAME rules.

const DAY_SCAN_USER = `Evaluate these stocks for INTRADAY trades. For each, decide BUY, SELL, or SKIP.
NOTE: You only have indicators (no candle data). For extreme movers (>20%), max confidence 7 — you'd need candles to be sure.

${DAY_TRADE_RULES}

- SKIP anything without a clear edge — a stock moving 3% on average volume is noise.
- Better to SKIP 80% and return 2-3 great picks than recommend 10 mediocre ones.

Respond with a JSON array ONLY (no markdown, no backticks):
[{"ticker":"AAPL","signal":"BUY"|"SELL"|"SKIP","confidence":0-10,"reason":"1 sentence"}]

Stocks:
{{STOCK_DATA}}`;

const SWING_SCAN_USER = `Evaluate these stocks for SWING trades (multi-day holds). For each, decide BUY, SELL, or SKIP.
NOTE: You only have indicators (no candle data). For extreme movers (>20%), max confidence 6-7 — you'd need candles to be sure.

${SWING_TRADE_RULES}

- SKIP anything without a clear edge or in no-man's-land (between SMA50 and SMA200, RSI 45-55).
- Better to SKIP 80% and return 3-5 solid picks than recommend 10 mediocre ones.

Respond with a JSON array ONLY (no markdown, no backticks):
[{"ticker":"AAPL","signal":"BUY"|"SELL"|"SKIP","confidence":0-10,"reason":"1 sentence"}]

Stocks:
{{STOCK_DATA}}`;

// Pass 2 refine: SAME system + rules as full analysis, just batch output format.

const DAY_REFINE_USER = `Evaluate each stock for an INTRADAY trade using the indicators and candle data provided.

${DAY_TRADE_RULES}

Output: JSON array ONLY (no markdown, no backticks). Use SKIP instead of HOLD.
[{"ticker":"AAPL","signal":"BUY"|"SELL"|"SKIP","confidence":0-10,"reason":"1-2 sentences"}]

{{STOCKS}}`;

const SWING_REFINE_USER = `Evaluate each stock for a SWING trade (multi-day hold) using the indicators and candle data provided.

${SWING_TRADE_RULES}

Output: JSON array ONLY (no markdown, no backticks). Use SKIP instead of HOLD.
[{"ticker":"AAPL","signal":"BUY"|"SELL"|"SKIP","confidence":0-10,"reason":"1-2 sentences"}]

{{STOCKS}}`;

// ── Build TradeIdea from AI eval + Yahoo quote ──────────

function buildIdea(
  eval_: AIEval,
  quote: YahooQuote,
  mode: 'DAY_TRADE' | 'SWING_TRADE',
): TradeIdea | null {
  if (eval_.signal === 'SKIP' || eval_.confidence < 7) return null;
  const price = rawVal(quote.regularMarketPrice);
  const change = rawVal(quote.regularMarketChange);
  const changePct = rawVal(quote.regularMarketChangePercent);
  const volume = rawVal(quote.regularMarketVolume);
  const avgVol = rawVal(quote.averageDailyVolume10Day);
  const volRatio = avgVol > 0 ? volume / avgVol : 0;

  const tags: string[] = [];
  if (Math.abs(changePct) >= 5) tags.push('momentum');
  if (volRatio >= 3) tags.push('volume-surge');
  else if (volRatio >= 2) tags.push('high-volume');
  if (Math.abs(changePct) >= 15) tags.push('extreme-move');
  if (mode === 'SWING_TRADE') {
    const sma50 = rawVal(quote.fiftyDayAverage);
    if (sma50 > 0 && Math.abs((price - sma50) / sma50) <= 0.02) tags.push('at-sma50');
  }

  return {
    ticker: eval_.ticker,
    name: quote.shortName ?? quote.longName ?? eval_.ticker,
    price: round(price),
    change: round(change),
    changePercent: round(changePct, 1),
    signal: eval_.signal as 'BUY' | 'SELL',
    confidence: Math.max(0, Math.min(10, Math.round(eval_.confidence))),
    reason: eval_.reason,
    tags,
    mode,
  };
}

// ── Supabase DB helpers ─────────────────────────────────

function getSupabase() {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

interface DBRow {
  id: string;
  data: TradeIdea[];
  scanned_at: string;
  expires_at: string;
}

async function readFromDB(sb: ReturnType<typeof createClient>, id: string): Promise<DBRow | null> {
  const { data, error } = await sb.from('trade_scans').select('*').eq('id', id).single();
  if (error || !data) return null;
  return data as DBRow;
}

async function writeToDB(
  sb: ReturnType<typeof createClient>,
  id: string,
  ideas: TradeIdea[],
  ttlMinutes: number,
): Promise<void> {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
  await sb.from('trade_scans').upsert({
    id,
    data: ideas,
    scanned_at: now,
    expires_at: expires,
  });
}

function isStale(row: DBRow | null): boolean {
  if (!row) return true;
  return new Date(row.expires_at).getTime() < Date.now();
}

// ── Pre-filter candidates before AI ─────────────────────
// Light rule-based filter to avoid sending garbage to Gemini.

function preDayFilter(q: YahooQuote): boolean {
  const price = rawVal(q.regularMarketPrice);
  const absPct = Math.abs(rawVal(q.regularMarketChangePercent));
  const volume = rawVal(q.regularMarketVolume);
  if (price < 3 || !q.symbol) return false;
  if (absPct < 3) return false;
  if (volume < 500_000) return false;
  return true;
}

function preSwingFilter(q: YahooQuote): boolean {
  const price = rawVal(q.regularMarketPrice);
  if (price < 5 || !q.symbol) return false;
  return true;
}

// ── Main handler ────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // Parse optional portfolio tickers + force refresh flag
    let portfolioTickers: string[] = [];
    let forceRefresh = false;
    try {
      const body = await req.json();
      if (Array.isArray(body?.portfolioTickers)) {
        portfolioTickers = body.portfolioTickers
          .map((t: unknown) => String(t).trim().toUpperCase())
          .filter((t: string) => t.length > 0 && t.length <= 10);
      }
      if (body?.forceRefresh === true) forceRefresh = true;
    } catch { /* no body */ }

    // Collect Gemini keys
    const GEMINI_KEYS: string[] = [];
    const primary = Deno.env.get('GEMINI_API_KEY');
    if (primary) GEMINI_KEYS.push(primary);
    for (let i = 2; ; i++) {
      const k = Deno.env.get(`GEMINI_API_KEY_${i}`);
      if (!k) break;
      GEMINI_KEYS.push(k);
    }

    const sb = getSupabase();

    // ── Read cached results from DB ──
    const [dayRow, swingRow] = await Promise.all([
      readFromDB(sb, 'day_trades'),
      readFromDB(sb, 'swing_trades'),
    ]);

    const dayStale = isStale(dayRow);
    const swingStale = isStale(swingRow);
    const marketOpen = isMarketOpen();
    const swingWindow = isSwingRefreshWindow();

    // Determine what needs refreshing
    // "Never scanned" = scanned_at is more than 24h ago (seeded with NOW()-1day)
    const dayNeverScanned = !dayRow || (Date.now() - new Date(dayRow.scanned_at).getTime() > 24 * 60 * 60 * 1000);
    const swingNeverScanned = !swingRow || (Date.now() - new Date(swingRow.scanned_at).getTime() > 24 * 60 * 60 * 1000);
    const needDayRefresh = forceRefresh || (dayStale && marketOpen) || dayNeverScanned;
    const needSwingRefresh = forceRefresh || (swingStale && (swingWindow || swingNeverScanned)) || swingNeverScanned;

    console.log(`[Trade Scanner] day=${dayStale ? 'STALE' : 'FRESH'} swing=${swingStale ? 'STALE' : 'FRESH'} market=${marketOpen ? 'OPEN' : 'CLOSED'} swingWindow=${swingWindow} refreshDay=${needDayRefresh} refreshSwing=${needSwingRefresh}`);

    // If both are fresh, return from DB immediately
    if (!needDayRefresh && !needSwingRefresh) {
      const result: ScanResult = {
        dayTrades: dayRow?.data ?? [],
        swingTrades: swingRow?.data ?? [],
        timestamp: Date.now(),
        cached: true,
      };
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (GEMINI_KEYS.length === 0) {
      console.warn('[Trade Scanner] No Gemini keys — returning cached data');
      return new Response(JSON.stringify({
        dayTrades: dayRow?.data ?? [],
        swingTrades: swingRow?.data ?? [],
        timestamp: Date.now(),
        cached: true,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── Refresh day trades ──
    let dayIdeas: TradeIdea[] = dayRow?.data ?? [];
    if (needDayRefresh) {
      console.log('[Trade Scanner] Refreshing day trades...');
      const [gainers, losers] = await Promise.all([
        fetchMovers('day_gainers'),
        fetchMovers('day_losers'),
      ]);

      // Pre-filter and take top 15 candidates by magnitude
      const allMovers = [...gainers, ...losers].filter(preDayFilter);
      const deduped = new Map<string, YahooQuote>();
      for (const q of allMovers) {
        const sym = q.symbol;
        if (!deduped.has(sym) || Math.abs(rawVal(q.regularMarketChangePercent)) > Math.abs(rawVal(deduped.get(sym)!.regularMarketChangePercent))) {
          deduped.set(sym, q);
        }
      }
      let candidates = [...deduped.values()]
        .sort((a, b) => Math.abs(rawVal(b.regularMarketChangePercent)) - Math.abs(rawVal(a.regularMarketChangePercent)))
        .slice(0, 15);

      // Enrich day trade candidates with chart data (indicators: RSI, MACD, ATR)
      // This is critical for matching the full analysis signal
      const enrichedQuotes = await fetchSwingQuotes(candidates.map(q => q.symbol));
      const enrichMap = new Map(enrichedQuotes.map(q => [q.symbol, q]));
      candidates = candidates.map(q => {
        const enriched = enrichMap.get(q.symbol);
        if (enriched) {
          // Merge: keep screener's real-time data but add indicators + SMAs from chart
          return {
            ...q,
            fiftyDayAverage: enriched.fiftyDayAverage,
            twoHundredDayAverage: enriched.twoHundredDayAverage,
            fiftyTwoWeekHigh: enriched.fiftyTwoWeekHigh,
            fiftyTwoWeekLow: enriched.fiftyTwoWeekLow,
            _indicators: enriched._indicators,
          };
        }
        return q;
      });
      console.log(`[Trade Scanner] Enriched ${enrichedQuotes.length}/${candidates.length} day candidates with indicators`);

      if (candidates.length > 0) {
        const stockData = candidates.map((q, i) => formatQuoteForAI(q, i)).join('\n');
        const prompt = DAY_SCAN_USER.replace('{{STOCK_DATA}}', stockData);

        try {
          // ── Pass 1: Quick scan with indicators only ──
          const raw = await callGemini(GEMINI_KEYS, DAY_TRADE_SYSTEM, prompt, 0.15, 2000);
          const evals: AIEval[] = JSON.parse(cleanJson(raw));
          const quoteMap = new Map(candidates.map(q => [q.symbol, q]));

          const pass1 = evals
            .filter(e => e.signal !== 'SKIP' && e.confidence >= 6) // Lower threshold for pass 1 — pass 2 will tighten
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 8); // Keep top 8 for refinement

          console.log(`[Trade Scanner] Day Pass 1: ${candidates.length} → ${pass1.length} shortlisted (${pass1.map(e => `${e.ticker}:${e.signal}/${e.confidence}`).join(', ')})`);

          // ── Pass 2: Refine top picks with multi-timeframe candles (5m + 15m) ──
          if (pass1.length > 0) {
            console.log(`[Trade Scanner] Fetching 5m + 15m candles for ${pass1.length} day candidates...`);
            const [candles5m, candles15m] = await Promise.all([
              Promise.all(pass1.map(async (e) => ({
                ticker: e.ticker,
                candles: await fetchCandleData(e.ticker, '5m', '1d'),
              }))),
              Promise.all(pass1.map(async (e) => ({
                ticker: e.ticker,
                candles: await fetchCandleData(e.ticker, '15m', '5d'),
              }))),
            ]);

            const stockBlocks = pass1.map((e) => {
              const q = quoteMap.get(e.ticker);
              const c5 = candles5m.find(c => c.ticker === e.ticker);
              const c15 = candles15m.find(c => c.ticker === e.ticker);
              const summary = formatQuoteForAI(q!, 0);
              const text5m = c5 && c5.candles.length > 0
                ? formatCandlesCompact(c5.candles, 30)
                : 'No 5m candles available';
              const text15m = c15 && c15.candles.length > 0
                ? formatCandlesCompact(c15.candles, 20)
                : 'No 15m candles available';
              return `--- ${e.ticker} ---\nIndicators: ${summary}\nPass-1 signal: ${e.signal}/${e.confidence} ("${e.reason}")\n\n5m Candles (today, ET):\n${text5m}\n\n15m Candles (5-day, ET):\n${text15m}`;
            }).join('\n\n');

            const refinePrompt = DAY_REFINE_USER.replace('{{STOCKS}}', stockBlocks);
            const refineRaw = await callGemini(GEMINI_KEYS, DAY_TRADE_SYSTEM, refinePrompt, 0.15, 2000);
            const refined: AIEval[] = JSON.parse(cleanJson(refineRaw));

            dayIdeas = refined
              .filter(e => e.signal !== 'SKIP' && e.confidence >= 7)
              .map(e => {
                const q = quoteMap.get(e.ticker);
                return q ? buildIdea(e, q, 'DAY_TRADE') : null;
              })
              .filter((x): x is TradeIdea => x !== null)
              .sort((a, b) => b.confidence - a.confidence)
              .slice(0, 6);

            console.log(`[Trade Scanner] Day Pass 2: ${pass1.length} refined → ${dayIdeas.length} final (${dayIdeas.map(d => `${d.ticker}:${d.signal}/${d.confidence}`).join(', ')})`);
          }
        } catch (err) {
          console.error('[Trade Scanner] Day AI eval failed:', err);
          // Keep stale data if AI fails
        }
      }

      await writeToDB(sb, 'day_trades', dayIdeas, 30); // 30 min TTL
    }

    // ── Refresh swing trades ──
    let swingIdeas: TradeIdea[] = swingRow?.data ?? [];
    if (needSwingRefresh) {
      console.log('[Trade Scanner] Refreshing swing trades...');
      const swingSymbols = [...new Set([...SWING_UNIVERSE, ...portfolioTickers])];
      const swingQuotes = await fetchSwingQuotes(swingSymbols);
      const candidates = swingQuotes.filter(preSwingFilter);

      if (candidates.length > 0) {
        const stockData = candidates.map((q, i) => formatQuoteForAI(q, i)).join('\n');
        const prompt = SWING_SCAN_USER.replace('{{STOCK_DATA}}', stockData);

        try {
          // ── Pass 1: Quick scan with indicators only ──
          const raw = await callGemini(GEMINI_KEYS, SWING_TRADE_SYSTEM, prompt, 0.15, 3000);
          const evals: AIEval[] = JSON.parse(cleanJson(raw));
          const quoteMap = new Map(candidates.map(q => [q.symbol, q]));

          // Log top AI evaluations for debugging
          const nonSkip = evals.filter(e => e.signal !== 'SKIP').sort((a, b) => b.confidence - a.confidence);
          const topSkips = evals.filter(e => e.signal === 'SKIP').sort((a, b) => b.confidence - a.confidence).slice(0, 3);
          console.log(`[Trade Scanner] Swing Pass 1 non-SKIP: ${nonSkip.slice(0, 5).map(e => `${e.ticker}:${e.signal}/${e.confidence}`).join(', ') || 'none'}`);
          console.log(`[Trade Scanner] Swing Pass 1 sample SKIPs: ${topSkips.map(e => `${e.ticker}(${e.confidence}): ${e.reason.slice(0, 50)}`).join(' | ') || 'none'}`);

          const pass1 = nonSkip
            .filter(e => e.confidence >= 5) // Lower threshold for pass 1
            .slice(0, 8);

          // ── Pass 2: Refine top picks with daily candles ──
          if (pass1.length > 0) {
            console.log(`[Trade Scanner] Fetching daily candles for ${pass1.length} swing candidates...`);
            const candleResults = await Promise.all(
              pass1.map(async (e) => ({
                ticker: e.ticker,
                candles: await fetchCandleData(e.ticker, '1d', '3mo'),
              }))
            );

            const stockBlocks = pass1.map((e) => {
              const q = quoteMap.get(e.ticker);
              const cr = candleResults.find(c => c.ticker === e.ticker);
              const summary = formatQuoteForAI(q!, 0);
              const candleText = cr && cr.candles.length > 0
                ? formatCandlesCompact(cr.candles, 20) // Last 20 daily candles
                : 'No daily candles available';
              return `--- ${e.ticker} ---\nIndicators: ${summary}\nPass-1 signal: ${e.signal}/${e.confidence} ("${e.reason}")\nDaily Candles (recent 20 days):\n${candleText}`;
            }).join('\n\n');

            const refinePrompt = SWING_REFINE_USER.replace('{{STOCKS}}', stockBlocks);
            const refineRaw = await callGemini(GEMINI_KEYS, SWING_TRADE_SYSTEM, refinePrompt, 0.15, 3000);
            const refined: AIEval[] = JSON.parse(cleanJson(refineRaw));

            swingIdeas = refined
              .filter(e => e.signal !== 'SKIP' && e.confidence >= 6)
              .map(e => {
                const q = quoteMap.get(e.ticker);
                return q ? buildIdea(e, q, 'SWING_TRADE') : null;
              })
              .filter((x): x is TradeIdea => x !== null)
              .sort((a, b) => b.confidence - a.confidence)
              .slice(0, 6);

            console.log(`[Trade Scanner] Swing Pass 2: ${pass1.length} refined → ${swingIdeas.length} final (${swingIdeas.map(d => `${d.ticker}:${d.signal}/${d.confidence}`).join(', ')})`);
          } else {
            console.log(`[Trade Scanner] Swing: ${candidates.length} candidates → 0 passed pass 1, skipping pass 2`);
          }
        } catch (err) {
          console.error('[Trade Scanner] Swing AI eval failed:', err);
        }
      }

      await writeToDB(sb, 'swing_trades', swingIdeas, 360); // 6 hour TTL
    }

    const result: ScanResult = {
      dayTrades: dayIdeas,
      swingTrades: swingIdeas,
      timestamp: Date.now(),
    };

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Trade Scanner] Error:', message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
