// Portfolio Assistant — Trade Scanner Edge Function (v5)
//
// Architecture (two-pass):
//   1. DISCOVERY  — Yahoo Finance screener finds movers (free, fast)
//   2. PASS 1     — Gemini AI batch-evaluates candidates on lightweight indicators (quick filter)
//   3. PASS 2     — Top picks get full 13-indicator analysis using the SAME shared
//                   computeAllIndicators + formatIndicatorsForPrompt code as full analysis.
//                   Day trades: fresh 15min candles for indicators (matches FA).
//                   Swing trades: reuse daily chart data (matches FA).
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
  DAY_REFINE_USER,
  SWING_REFINE_USER,
} from '../_shared/prompts.ts';
import {
  fetchCandles,
  fetchMarketSnapshot,
  fetchYahooNews,
  fetchFundamentalsBatch,
  formatFundamentalsForAI,
} from '../_shared/data-fetchers.ts';
import {
  type OHLCV,
  computeAllIndicators,
  formatIndicatorsForPrompt,
} from '../_shared/indicators.ts';
import { buildFeedbackContext } from '../_shared/feedback.ts';

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
  // Computed indicators from chart data (Pass 1 only — lightweight)
  _pass1Indicators?: Pass1Indicators;
  // Raw OHLCV bars from chart data (newest-first, for Pass 2 reuse)
  _ohlcvBars?: OHLCV[];
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

// ── Pass 1 indicators (lightweight, from daily closes) ───
// These are ONLY used for the quick Pass 1 filter — NOT for Pass 2.

interface Pass1Indicators {
  rsi14: number | null;
  macdHistogram: number | null;
  sma20: number | null;
  atr14: number | null;
}

function computeRSI_pass1(closes: number[], period = 14): number | null {
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

function computeMACDHistogram_pass1(closes: number[], fast = 12, slow = 26, sig = 9): number | null {
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

function computeATR_pass1(highs: number[], lows: number[], closes: number[], period = 14): number | null {
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

function computePass1Indicators(closes: number[], highs: number[], lows: number[]): Pass1Indicators {
  return {
    rsi14: computeRSI_pass1(closes),
    macdHistogram: computeMACDHistogram_pass1(closes),
    sma20: closes.length >= 20 ? round(closes.slice(-20).reduce((a, b) => a + b, 0) / 20, 2) : null,
    atr14: computeATR_pass1(highs, lows, closes),
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
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
}

function isSwingRefreshWindow(): boolean {
  const { hour, minute, dayOfWeek } = getETNow();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const mins = hour * 60 + minute;
  return (mins >= 9 * 60 + 45 && mins <= 10 * 60 + 15) ||
         (mins >= 15 * 60 + 30 && mins <= 16 * 60);
}

// ── Yahoo Finance data fetchers (Pass 1 discovery) ──────

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
    const highs: (number | null)[] = quotes.high ?? [];
    const lows: (number | null)[] = quotes.low ?? [];
    const opens: (number | null)[] = quotes.open ?? [];
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

    // Compute lightweight Pass 1 indicators (oldest-first)
    const rawHighs = highs.filter((h): h is number => h != null);
    const rawLows = lows.filter((l): l is number => l != null);
    const pass1Ind = computePass1Indicators(validCloses, rawHighs, rawLows);

    // Build OHLCV bars in newest-first order (shared indicators expect this)
    const ohlcvBars: OHLCV[] = [];
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null && opens[i] != null && highs[i] != null && lows[i] != null) {
        ohlcvBars.push({
          o: opens[i]!,
          h: highs[i]!,
          l: lows[i]!,
          c: closes[i]!,
          v: volumes[i] ?? 0,
        });
      }
    }

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
      _pass1Indicators: pass1Ind,
      _ohlcvBars: ohlcvBars,  // Stored for Pass 2 reuse — no re-fetch needed
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

// ── Format stock data for AI prompt (Pass 1 only) ───────

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
  const ind = q._pass1Indicators;

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

// ── AI prompts (Pass 1 only — Pass 2 uses shared prompts from _shared/prompts.ts) ────

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

// ── Build TradeIdea from AI eval + Yahoo quote ──────────

function buildIdea(
  eval_: AIEval,
  quote: YahooQuote,
  mode: 'DAY_TRADE' | 'SWING_TRADE',
): TradeIdea | null {
  if (eval_.signal === 'SKIP' || eval_.confidence < 6) return null;
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

// ── Pass 2: Full indicator analysis ─────────────────────
// Uses the EXACT SAME computeAllIndicators + formatIndicatorsForPrompt
// from _shared/indicators.ts as full analysis.
//
// Day trades:  fetch 15min candles (1 API call per ticker) → compute indicators → same as FA
// Swing trades: reuse daily OHLCV from chart enrichment (zero fetches) → compute indicators → same as FA

async function runPass2(
  pass1: AIEval[],
  quoteMap: Map<string, YahooQuote>,
  mode: 'DAY_TRADE' | 'SWING_TRADE',
  geminiKeys: string[],
): Promise<TradeIdea[]> {
  const tickers = pass1.map(e => e.ticker);
  console.log(`[Trade Scanner] Pass 2: ${tickers.length} ${mode === 'DAY_TRADE' ? 'day' : 'swing'} candidates...`);

  // Fetch market snapshot + feedback context in parallel
  const [marketSnapshot, feedbackCtx] = await Promise.all([
    fetchMarketSnapshot(),
    buildFeedbackContext(),
  ]);
  const marketCtxStr = marketSnapshot
    ? `SPY: ${marketSnapshot.spyTrend} | VIX: ${marketSnapshot.vix} (${marketSnapshot.volatility} fear)`
    : undefined;

  // ── Evaluate each stock INDIVIDUALLY (same depth as FA) ──
  const systemPrompt = mode === 'DAY_TRADE' ? DAY_TRADE_SYSTEM : SWING_TRADE_SYSTEM;
  const refineTemplate = mode === 'DAY_TRADE' ? DAY_REFINE_USER : SWING_REFINE_USER;
  const results: AIEval[] = [];

  for (const ticker of tickers) {
    const quote = quoteMap.get(ticker);

    // ── Fetch all timeframes matching FA — same candles the AI sees ──
    let ohlcvBars: OHLCV[] | null = null;
    const trimmedTimeframes: Record<string, unknown> = {};

    if (mode === 'DAY_TRADE') {
      // Fetch 15min candles — same timeframe FA uses for indicators
      const c15m = await fetchCandles(ticker, '15min', 150);
      if (c15m?.values?.length) {
        ohlcvBars = c15m.values.map(v => ({
          o: parseFloat(v.open), h: parseFloat(v.high),
          l: parseFloat(v.low), c: parseFloat(v.close),
          v: v.volume ? parseFloat(v.volume) : 0,
        }));
        trimmedTimeframes['15min'] = c15m.values.slice(0, 40).map(v => ({
          t: v.datetime, o: parseFloat(v.open), h: parseFloat(v.high),
          l: parseFloat(v.low), c: parseFloat(v.close),
          v: v.volume ? parseFloat(v.volume) : 0,
        }));
      }
    } else {
      // Swing: reuse daily OHLCV from chart enrichment (zero fetches)
      ohlcvBars = quote?._ohlcvBars ?? null;
      if (ohlcvBars && ohlcvBars.length > 0) {
        trimmedTimeframes['1day'] = ohlcvBars.slice(0, 40).map(b => ({
          o: b.o, h: b.h, l: b.l, c: b.c, v: b.v,
        }));
      }
    }

    if (!ohlcvBars || ohlcvBars.length < 30) {
      console.log(`[Trade Scanner] ${ticker}: insufficient data, skipping`);
      continue;
    }

    // ── Compute full indicators — SAME code as full analysis ──
    const indicators = computeAllIndicators(ohlcvBars);
    const currentPrice = ohlcvBars[0]?.c ?? rawVal(quote?.regularMarketPrice);
    const indicatorText = formatIndicatorsForPrompt(indicators, currentPrice, marketCtxStr);

    // ── News + Fundamentals (swing only) ──
    const news = await fetchYahooNews(ticker);
    let extraContext = '';
    if (mode === 'SWING_TRADE') {
      const fundMap = await fetchFundamentalsBatch([ticker]);
      const fund = fundMap.get(ticker);
      if (fund) extraContext += `\n\nFundamentals: ${formatFundamentalsForAI(fund)}`;
    }

    const candleJson = JSON.stringify({ timeframes: trimmedTimeframes, currentPrice });

    // ── Build prompt in the EXACT SAME format as FA ──
    const userPrompt = refineTemplate
      .replace('{{INDICATOR_SUMMARY}}', indicatorText + extraContext + feedbackCtx)
      .replace('{{TECHNICAL_DATA}}', candleJson)
      .replace('{{SENTIMENT_DATA}}', JSON.stringify(news.length > 0
        ? news.map(n => ({ headline: n.headline, source: n.source }))
        : [{ headline: 'No recent news available', source: '' }]));

    try {
      const raw = await callGemini(geminiKeys, systemPrompt, userPrompt, 0.15, 1000);
      const parsed = JSON.parse(cleanJson(raw));
      results.push({
        ticker,
        signal: parsed.signal ?? 'SKIP',
        confidence: parsed.confidence ?? 0,
        reason: parsed.reason ?? '',
      });
      console.log(`[Trade Scanner] ${ticker}: ${parsed.signal}/${parsed.confidence}`);
    } catch (err) {
      console.warn(`[Trade Scanner] ${ticker} Pass 2 failed:`, err);
    }
  }

  // 7+ for both modes — balances quantity with FA direction consistency
  const minConfidence = 7;
  const ideas = results
    .filter(e => e.signal !== 'SKIP' && e.confidence >= minConfidence)
    .map(e => {
      const q = quoteMap.get(e.ticker);
      return q ? buildIdea(e, q, mode) : null;
    })
    .filter((x): x is TradeIdea => x !== null)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 6);

  console.log(`[Trade Scanner] ${mode} Pass 2: ${pass1.length} refined → ${ideas.length} final (${ideas.map(d => `${d.ticker}:${d.signal}/${d.confidence}`).join(', ')})`);
  return ideas;
}

// ── Main handler ────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
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

    const dayNeverScanned = !dayRow || (Date.now() - new Date(dayRow.scanned_at).getTime() > 24 * 60 * 60 * 1000);
    const swingNeverScanned = !swingRow || (Date.now() - new Date(swingRow.scanned_at).getTime() > 24 * 60 * 60 * 1000);
    const needDayRefresh = forceRefresh || (dayStale && marketOpen) || dayNeverScanned;
    const needSwingRefresh = forceRefresh || (swingStale && (swingWindow || swingNeverScanned)) || swingNeverScanned;

    console.log(`[Trade Scanner] day=${dayStale ? 'STALE' : 'FRESH'} swing=${swingStale ? 'STALE' : 'FRESH'} market=${marketOpen ? 'OPEN' : 'CLOSED'} swingWindow=${swingWindow} refreshDay=${needDayRefresh} refreshSwing=${needSwingRefresh}`);

    if (!needDayRefresh && !needSwingRefresh) {
      return new Response(JSON.stringify({
        dayTrades: dayRow?.data ?? [],
        swingTrades: swingRow?.data ?? [],
        timestamp: Date.now(),
        cached: true,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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

      // Enrich day trade candidates with chart data for Pass 1 indicators + OHLCV bars
      const enrichedQuotes = await fetchSwingQuotes(candidates.map(q => q.symbol));
      const enrichMap = new Map(enrichedQuotes.map(q => [q.symbol, q]));
      candidates = candidates.map(q => {
        const enriched = enrichMap.get(q.symbol);
        if (enriched) {
          return {
            ...q,
            fiftyDayAverage: enriched.fiftyDayAverage,
            twoHundredDayAverage: enriched.twoHundredDayAverage,
            fiftyTwoWeekHigh: enriched.fiftyTwoWeekHigh,
            fiftyTwoWeekLow: enriched.fiftyTwoWeekLow,
            _pass1Indicators: enriched._pass1Indicators,
            _ohlcvBars: enriched._ohlcvBars,
          };
        }
        return q;
      });

      if (candidates.length > 0) {
        const stockData = candidates.map((q, i) => formatQuoteForAI(q, i)).join('\n');
        const prompt = DAY_SCAN_USER.replace('{{STOCK_DATA}}', stockData);

        try {
          // ── Pass 1: Quick scan with lightweight indicators ──
          const raw = await callGemini(GEMINI_KEYS, DAY_TRADE_SYSTEM, prompt, 0.15, 2000);
          const evals: AIEval[] = JSON.parse(cleanJson(raw));
          const quoteMap = new Map(candidates.map(q => [q.symbol, q]));

          const pass1 = evals
            .filter(e => e.signal !== 'SKIP' && e.confidence >= 6)
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 3);

          console.log(`[Trade Scanner] Day Pass 1: ${candidates.length} → ${pass1.length} shortlisted (${pass1.map(e => `${e.ticker}:${e.signal}/${e.confidence}`).join(', ')})`);

          // ── Pass 2: Full shared indicator analysis ──
          if (pass1.length > 0) {
            dayIdeas = await runPass2(pass1, quoteMap, 'DAY_TRADE', GEMINI_KEYS);
          }
        } catch (err) {
          console.error('[Trade Scanner] Day AI eval failed:', err);
        }
      }

      await writeToDB(sb, 'day_trades', dayIdeas, 30);
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
          // ── Pass 1: Quick scan with lightweight indicators ──
          const raw = await callGemini(GEMINI_KEYS, SWING_TRADE_SYSTEM, prompt, 0.15, 3000);
          const evals: AIEval[] = JSON.parse(cleanJson(raw));
          const quoteMap = new Map(candidates.map(q => [q.symbol, q]));

          const nonSkip = evals.filter(e => e.signal !== 'SKIP').sort((a, b) => b.confidence - a.confidence);
          console.log(`[Trade Scanner] Swing Pass 1 non-SKIP: ${nonSkip.slice(0, 5).map(e => `${e.ticker}:${e.signal}/${e.confidence}`).join(', ') || 'none'}`);

          const pass1 = nonSkip
            .filter(e => e.confidence >= 5)
            .slice(0, 3);

          // ── Pass 2: Full shared indicator analysis ──
          if (pass1.length > 0) {
            swingIdeas = await runPass2(pass1, quoteMap, 'SWING_TRADE', GEMINI_KEYS);
          } else {
            console.log(`[Trade Scanner] Swing: ${candidates.length} candidates → 0 passed pass 1, skipping pass 2`);
          }
        } catch (err) {
          console.error('[Trade Scanner] Swing AI eval failed:', err);
        }
      }

      await writeToDB(sb, 'swing_trades', swingIdeas, 360);
    }

    return new Response(JSON.stringify({
      dayTrades: dayIdeas,
      swingTrades: swingIdeas,
      timestamp: Date.now(),
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Trade Scanner] Error:', message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
