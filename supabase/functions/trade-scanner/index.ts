// Portfolio Assistant — Trade Scanner Edge Function (v6)
//
// Architecture (two-pass):
//   1. DISCOVERY  — Yahoo Finance screener finds movers (free, fast)
//   2. PASS 1     — Gemini AI batch-evaluates candidates on lightweight indicators (quick filter)
//   3. PASS 2     — Top picks get FA-GRADE PROMPT analysis — uses the IDENTICAL prompt
//                   format as Full Analysis (scenarios, entry/stop/target, rationale) which
//                   forces the AI to think deeper. Efficient data pipeline (15min candles
//                   for day, daily Yahoo OHLCV for swing) keeps execution fast.
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
  DAY_TRADE_STRUCTURE_REQUIREMENTS,
  SWING_TRADE_SYSTEM,
  SWING_TRADE_RULES,
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
  confidence: number;     // 0-10 from AI (Pass 2 / full analysis scale)
  reason: string;        // AI-generated 1-sentence rationale
  tags: string[];
  mode: 'DAY_TRADE' | 'SWING_TRADE';
  // Validation log (for 10–20 day analysis)
  in_play_score?: number;
  pass1_confidence?: number;
  market_condition?: 'trend' | 'chop';
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
  // InPlayScore debug (large-cap day trade ranking)
  _inPlayScore?: number;
  _volRatio?: number;
  _dollarVol?: number;
  _atrPct?: number;
  _dayRangePct?: number;
  _gapPct?: number;
  _trendScore?: number;
  _extensionPenalty?: number;
  // SwingSetupScore debug (swing pre-ranking)
  _swingSetupScore?: number;
  _trendScore?: number;   // swing trendScore 0-10
  _pullbackScore?: number; // swing pullbackScore 0-10
  _extensionPenalty?: number; // day=InPlayScore ext; swing=SwingSetupScore ext
}

// AI response shape for one stock
interface AIEval {
  ticker: string;
  signal: 'BUY' | 'SELL' | 'SKIP' | 'HOLD';
  confidence: number;  // 0-10
  reason: string;
}

// ── Swing universe: Core (always scanned) + Dynamic (refreshed daily) ──
// Hybrid approach: blue chips always covered, dynamic layer catches emerging opportunities

const SWING_CORE = [
  // Mega-cap tech (always liquid, always swingable)
  'AAPL', 'MSFT', 'NVDA', 'GOOG', 'AMZN', 'META', 'TSLA', 'AVGO',
  // Finance leaders
  'JPM', 'V', 'GS',
  // Healthcare
  'UNH', 'LLY', 'ABBV',
  // Consumer
  'COST', 'WMT', 'HD',
  // Energy & Industrial
  'XOM', 'CAT',
  // Top growth
  'CRWD', 'PLTR',
];

// Sector ETFs for momentum rotation
const SECTOR_ETFS = ['XLK', 'XLF', 'XLV', 'XLE', 'XLI', 'XLC', 'XLY', 'XLP', 'XLU', 'XLRE', 'XLB'];

// Mapping: sector ETF → representative large-cap stocks to add when sector is hot
const SECTOR_STOCKS: Record<string, string[]> = {
  XLK: ['CRM', 'ORCL', 'ADBE', 'AMD', 'INTC', 'QCOM', 'AMAT', 'MU', 'NOW', 'PANW'],
  XLF: ['BAC', 'MA', 'C', 'WFC', 'SCHW', 'BLK', 'AXP'],
  XLV: ['JNJ', 'MRK', 'PFE', 'TMO', 'ABT', 'ISRG', 'VRTX'],
  XLE: ['CVX', 'COP', 'SLB', 'EOG', 'OXY', 'PSX'],
  XLI: ['BA', 'GE', 'RTX', 'HON', 'UPS', 'LMT', 'DE'],
  XLC: ['NFLX', 'DIS', 'CMCSA', 'TMUS', 'EA'],
  XLY: ['NKE', 'MCD', 'SBUX', 'TJX', 'LULU', 'BKNG'],
  XLP: ['PG', 'KO', 'PEP', 'PM', 'CL', 'MDLZ'],
  XLU: ['NEE', 'DUK', 'SO', 'D', 'AEP'],
  XLRE: ['PLD', 'AMT', 'EQIX', 'SPG', 'O'],
  XLB: ['LIN', 'APD', 'SHW', 'FCX', 'NEM'],
};

/**
 * Build the dynamic swing universe — called once per swing scan refresh.
 *
 * Layers:
 *   1. CORE (~20 blue chips) — always included
 *   2. SECTOR MOMENTUM — top 2-3 performing sectors contribute their stocks
 *   3. YAHOO MOST ACTIVE — high volume names making big moves
 *   4. EARNINGS PLAYS — stocks with earnings 5-14 days out
 *   5. PORTFOLIO — always include user's existing holdings
 *
 * Result: deduplicated list of ~35-55 tickers, refreshed each scan.
 */
async function buildDynamicSwingUniverse(
  sb: ReturnType<typeof createClient>,
  portfolioTickers: string[],
): Promise<{ symbols: string[]; sources: Record<string, string[]> }> {
  const sources: Record<string, string[]> = { core: [...SWING_CORE] };

  // ── 1. Sector momentum: fetch ETF chart data, rank by 5-day performance ──
  try {
    const etfPerf: { symbol: string; changePct: number }[] = [];
    const etfResults = await Promise.all(
      SECTOR_ETFS.map(async (sym) => {
        try {
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=5d&interval=1d&includePrePost=false`;
          const res = await fetch(url, { headers: YAHOO_HEADERS });
          if (!res.ok) return null;
          const data = await res.json();
          const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter((c: number | null) => c != null) as number[] | undefined;
          if (closes && closes.length >= 2) {
            const changePct = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
            return { symbol: sym, changePct };
          }
          return null;
        } catch { return null; }
      })
    );
    for (const r of etfResults) { if (r) etfPerf.push(r); }

    // Pick top 3 sectors by absolute 5-day move (both rallying and selling sectors are interesting)
    const ranked = etfPerf
      .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
      .slice(0, 3);

    const sectorPicks: string[] = [];
    for (const etf of ranked) {
      const stocks = SECTOR_STOCKS[etf.symbol] ?? [];
      sectorPicks.push(...stocks.slice(0, 4));
    }
    if (sectorPicks.length > 0) {
      sources.sector_momentum = sectorPicks;
      console.log(`[Swing Universe] Sector momentum: top sectors ${ranked.map(e => `${e.symbol}(${e.changePct.toFixed(1)}%)`).join(', ')} → ${sectorPicks.length} stocks`);
    }
  } catch (err) {
    console.warn('[Swing Universe] Sector momentum fetch failed:', err);
  }

  // ── 2. Yahoo Most Active + Trending (high volume movers) ──
  try {
    const [activeRes, gainersRes, losersRes] = await Promise.all([
      fetchMovers('most_actives'),
      fetchMovers('day_gainers'),
      fetchMovers('day_losers'),
    ]);
    const movers = [...activeRes, ...gainersRes, ...losersRes]
      .filter(q => {
        const price = rawVal(q.regularMarketPrice);
        const vol = rawVal(q.regularMarketVolume);
        const avgVol = rawVal(q.averageDailyVolume10Day);
        const absPct = Math.abs(rawVal(q.regularMarketChangePercent));
        return price >= 10 && vol >= 1_000_000 && (avgVol > 0 ? vol / avgVol >= 1.5 : false) && absPct >= 2;
      })
      .map(q => q.symbol)
      .filter((s): s is string => !!s);
    const uniqueMovers = [...new Set(movers)].slice(0, 15);
    if (uniqueMovers.length > 0) {
      sources.yahoo_movers = uniqueMovers;
      console.log(`[Swing Universe] Yahoo movers: ${uniqueMovers.length} stocks with high volume+movement`);
    }
  } catch (err) {
    console.warn('[Swing Universe] Yahoo movers fetch failed:', err);
  }

  // ── 3. Earnings plays: stocks with earnings 5-14 days out ──
  try {
    const earningsWatchlist = [
      ...SWING_CORE,
      ...Object.values(SECTOR_STOCKS).flat(),
    ];
    const uniqueEarnings = [...new Set(earningsWatchlist)];
    const fundMap = await fetchFundamentalsBatch(uniqueEarnings);
    const earningsPicks: string[] = [];
    for (const [sym, fund] of fundMap.entries()) {
      if (fund.daysToEarnings != null && fund.daysToEarnings >= 5 && fund.daysToEarnings <= 14) {
        earningsPicks.push(sym);
      }
    }
    if (earningsPicks.length > 0) {
      sources.earnings_plays = earningsPicks;
      console.log(`[Swing Universe] Earnings plays: ${earningsPicks.join(', ')} (5-14 days out)`);
    }
  } catch (err) {
    console.warn('[Swing Universe] Earnings calendar fetch failed:', err);
  }

  // ── 4. Portfolio holdings: always include ──
  if (portfolioTickers.length > 0) {
    sources.portfolio = portfolioTickers;
  }

  // ── Combine & deduplicate ──
  const allTickers = new Set<string>();
  for (const arr of Object.values(sources)) {
    for (const t of arr) allTickers.add(t.toUpperCase());
  }

  const symbols = [...allTickers];
  console.log(`[Swing Universe] Final: ${symbols.length} unique tickers (core: ${SWING_CORE.length}, dynamic: ${symbols.length - SWING_CORE.length})`);
  console.log(`[Swing Universe] Sources: ${Object.entries(sources).map(([k, v]) => `${k}(${v.length})`).join(', ')}`);

  return { symbols, sources };
}

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

function formatDateToEtIso(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find(p => p.type === 'year')?.value ?? '0000';
  const month = parts.find(p => p.type === 'month')?.value ?? '00';
  const day = parts.find(p => p.type === 'day')?.value ?? '00';
  return `${year}-${month}-${day}`;
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

async function fetchMovers(type: 'day_gainers' | 'day_losers' | 'most_actives'): Promise<YahooQuote[]> {
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
  let cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json?\s*/g, '')
    .replace(/```/g, '')
    .trim();

  // Fix common AI JSON issues: trailing commas, single quotes
  cleaned = cleaned
    .replace(/,\s*([}\]])/g, '$1')        // trailing commas
    .replace(/'/g, '"');                    // single quotes → double quotes

  return cleaned;
}

/** Parse JSON array from AI with fallback repair */
function parseAIJsonArray(text: string): AIEval[] {
  const cleaned = cleanJson(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to extract individual JSON objects from malformed array
    const items: AIEval[] = [];
    const regex = /\{[^{}]*"ticker"\s*:\s*"([^"]+)"[^{}]*"signal"\s*:\s*"([^"]+)"[^{}]*"confidence"\s*:\s*(\d+)[^{}]*"reason"\s*:\s*"([^"]*)"[^{}]*\}/g;
    let match;
    while ((match = regex.exec(cleaned)) !== null) {
      items.push({
        ticker: match[1],
        signal: match[2] as AIEval['signal'],
        confidence: parseInt(match[3], 10),
        reason: match[4],
      });
    }
    if (items.length > 0) {
      console.log(`[Trade Scanner] Repaired malformed JSON: extracted ${items.length} items`);
      return items;
    }
    throw new Error(`Failed to parse AI response as JSON array`);
  }
}

// ── AI prompts (Pass 1 only — Pass 2 uses shared prompts from _shared/prompts.ts) ────

const DAY_SCAN_USER = `Evaluate these stocks for INTRADAY trades. For each, decide BUY, SELL, or SKIP.
NOTE: You only have indicators (no candle data). For extreme movers (>20%), max confidence 7 — you'd need candles to be sure.

${DAY_TRADE_RULES}

- This is a SCREENING pass — a deeper analysis with full candle data will validate later.
- SKIP stocks moving < 3% on average volume (noise) or with no clear setup.
- For everything else, give a directional call with honest confidence. The next pass will filter further.
- Aim to surface 3-5 actionable ideas from this list.

Respond with a JSON array ONLY (no markdown, no backticks):
[{"ticker":"AAPL","signal":"BUY"|"SELL"|"SKIP","confidence":0-10,"reason":"1 sentence"}]

Stocks:
{{STOCK_DATA}}`;

const SWING_SCAN_USER = `Evaluate these stocks for SWING trades (multi-day holds). For each, decide BUY, SELL, or SKIP.
NOTE: You only have indicators (no candle data). For extreme movers (>20%), max confidence 6-7 — you'd need candles to be sure.

${SWING_TRADE_RULES}

- This is a SCREENING pass — be generous with BUY/SELL signals. A deeper analysis with full candle data will validate later.
- Look for: pullbacks to support in uptrends, oversold bounces, breakout setups, breakdown setups, mean-reversion plays.
- Even in a bearish market, quality stocks at support with good risk/reward are valid BUY candidates.
- SELL (short) setups are equally valid — stocks breaking below SMA50/SMA200, bearish MACD crossovers.
- SKIP only when there is truly no setup (flat, no volume, no catalyst, stuck in the middle of a range with no direction).
- Aim to identify 6-10 actionable ideas from this list. The next pass will filter further.
- Confidence reflects how promising the SETUP looks, not certainty of outcome.

Respond with a JSON array ONLY (no markdown, no backticks):
[{"ticker":"AAPL","signal":"BUY"|"SELL"|"SKIP","confidence":0-10,"reason":"1 sentence"}]

Stocks:
{{STOCK_DATA}}`;

// ── Build TradeIdea from AI eval + Yahoo quote ──────────

function buildIdea(
  eval_: AIEval,
  quote: YahooQuote,
  mode: 'DAY_TRADE' | 'SWING_TRADE',
  opts?: { pass1Confidence?: number; marketCondition?: 'trend' | 'chop' },
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
    in_play_score: quote._inPlayScore,
    pass1_confidence: opts?.pass1Confidence,
    market_condition: opts?.marketCondition,
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

const largeCapMode = true; // TSLA/NVDA style; set false for small-cap

function preDayFilter(q: YahooQuote): boolean {
  const price = rawVal(q.regularMarketPrice);
  const absPct = Math.abs(rawVal(q.regularMarketChangePercent));
  const volume = rawVal(q.regularMarketVolume);
  if (!q.symbol) return false;
  if (largeCapMode) {
    if (price < 20) return false;
    if (absPct < 1) return false;
    if (volume < 1_000_000) return false;
  } else {
    if (price < 3) return false;
    if (absPct < 3) return false;
    if (volume < 500_000) return false;
  }
  return true;
}

/** Convert rank (1=best) to 0..10 score. Higher rank = higher score. */
function rankToScore(rank: number, total: number): number {
  if (total <= 1) return 10;
  return round(10 * (total - rank) / (total - 1), 2);
}

/** Compute trendScore 0..10 from price vs SMAs, MACD, RSI sweet spot. */
function computeTrendScore(q: YahooQuote): number {
  const price = rawVal(q.regularMarketPrice);
  const sma20 = q._pass1Indicators?.sma20 ?? null;
  const sma50 = rawVal(q.fiftyDayAverage);
  const sma200 = rawVal(q.twoHundredDayAverage);
  const macd = q._pass1Indicators?.macdHistogram ?? null;
  const rsi = q._pass1Indicators?.rsi14 ?? null;
  let score = 0;
  if (sma20 != null && price > sma20) score += 2;
  if (sma50 > 0 && price > sma50) score += 2;
  if (sma200 > 0 && price > sma200) score += 2;
  if (macd != null && macd > 0) score += 2;
  if (rsi != null && rsi >= 45 && rsi <= 65) score += 2;
  return Math.min(10, Math.max(0, score));
}

/** Compute InPlayScore and attach debug metrics to quote. Returns score. */
function computeInPlayScore(q: YahooQuote, candidates: YahooQuote[]): number {
  const price = rawVal(q.regularMarketPrice);
  const changePct = rawVal(q.regularMarketChangePercent);
  const volume = rawVal(q.regularMarketVolume);
  const avgVol = rawVal(q.averageDailyVolume10Day);
  const high = rawVal(q.regularMarketDayHigh);
  const low = rawVal(q.regularMarketDayLow);
  const open = rawVal(q.regularMarketOpen);
  const prevClose = rawVal(q.regularMarketPreviousClose);
  const atr14 = q._pass1Indicators?.atr14 ?? null;

  const volRatio = avgVol > 0 ? volume / avgVol : 0;
  const dollarVol = price * volume;
  const atrPct = (price > 0 && atr14 != null && atr14 > 0) ? (atr14 / price) * 100 : 0;
  const dayRangePct = (price > 0 && high > 0 && low > 0) ? ((high - low) / price) * 100 : 0;
  const gapPct = prevClose > 0 ? ((open - prevClose) / prevClose) * 100 : 0;

  (q as YahooQuote & { _volRatio: number })._volRatio = round(volRatio, 2);
  (q as YahooQuote & { _dollarVol: number })._dollarVol = round(dollarVol, 0);
  (q as YahooQuote & { _atrPct: number })._atrPct = round(atrPct, 2);
  (q as YahooQuote & { _dayRangePct: number })._dayRangePct = round(dayRangePct, 2);
  (q as YahooQuote & { _gapPct: number })._gapPct = round(gapPct, 2);

  const trendScore = computeTrendScore(q);
  (q as YahooQuote & { _trendScore: number })._trendScore = trendScore;

  const extensionPenalty = Math.max(0, Math.abs(changePct) - 3) * 0.7;
  (q as YahooQuote & { _extensionPenalty: number })._extensionPenalty = round(extensionPenalty, 2);

  const n = candidates.length;
  const volRatios = candidates.map(c => rawVal(c.regularMarketVolume) / Math.max(1, rawVal(c.averageDailyVolume10Day)));
  const dollarVols = candidates.map(c => rawVal(c.regularMarketPrice) * rawVal(c.regularMarketVolume));
  const atrPcts = candidates.map(c => {
    const p = rawVal(c.regularMarketPrice);
    const a = c._pass1Indicators?.atr14 ?? null;
    return (p > 0 && a != null && a > 0) ? (a / p) * 100 : 0;
  });

  const volRank = volRatios
    .map((v, i) => ({ v, i }))
    .sort((a, b) => b.v - a.v)
    .findIndex(x => x.i === candidates.indexOf(q)) + 1;
  const dollarRank = dollarVols
    .map((v, i) => ({ v, i }))
    .sort((a, b) => b.v - a.v)
    .findIndex(x => x.i === candidates.indexOf(q)) + 1;
  const atrRank = atrPcts
    .map((v, i) => ({ v, i }))
    .sort((a, b) => b.v - a.v)
    .findIndex(x => x.i === candidates.indexOf(q)) + 1;

  const volRatioScore = rankToScore(volRank, n);
  const dollarVolScore = rankToScore(dollarRank, n);
  const atrPctScore = rankToScore(atrRank, n);

  const inPlayScore = round(
    0.30 * volRatioScore + 0.25 * dollarVolScore + 0.20 * atrPctScore + 0.25 * trendScore - extensionPenalty,
    2
  );
  (q as YahooQuote & { _inPlayScore: number })._inPlayScore = inPlayScore;
  return inPlayScore;
}

function preSwingFilter(q: YahooQuote): boolean {
  const price = rawVal(q.regularMarketPrice);
  if (price < 5 || !q.symbol) return false;
  return true;
}

/** Compute SwingSetupScore and attach debug metrics. Uses daily data already fetched. */
function computeSwingSetupScore(q: YahooQuote): number {
  const price = rawVal(q.regularMarketPrice);
  const sma20 = q._pass1Indicators?.sma20 ?? null;
  const sma50 = rawVal(q.fiftyDayAverage);
  const sma200 = rawVal(q.twoHundredDayAverage);
  const rsi = q._pass1Indicators?.rsi14 ?? null;
  const macd = q._pass1Indicators?.macdHistogram ?? null;
  const bars = q._ohlcvBars ?? [];

  // Recent bar moves (newest-first: bars[0]=today, bars[4]=5 bars ago)
  const recent5BarMove = bars.length >= 5 && bars[4].c > 0
    ? Math.abs((bars[0].c - bars[4].c) / bars[4].c) * 100
    : 0;
  const recent10BarMove = bars.length >= 10 && bars[9].c > 0
    ? Math.abs((bars[0].c - bars[9].c) / bars[9].c) * 100
    : 0;

  // trendScore (0-10)
  let trendScore = 0;
  if (sma50 > 0 && price > sma50) trendScore += 3;
  if (sma200 > 0 && price > sma200) trendScore += 3;
  if (sma50 > 0 && sma200 > 0 && sma50 > sma200) trendScore += 2;
  if (macd != null && macd > 0) trendScore += 2;
  trendScore = Math.min(10, trendScore);

  // pullbackScore (0-10)
  let pullbackScore = 0;
  if (sma20 != null && sma20 > 0 && Math.abs((price - sma20) / sma20) <= 0.03) pullbackScore += 5;
  if (rsi != null && rsi >= 40 && rsi <= 55) pullbackScore += 3;
  if (recent5BarMove < 8) pullbackScore += 2;
  pullbackScore = Math.min(10, pullbackScore);

  // extensionPenalty
  let penalty = 0;
  if (recent5BarMove > 15) penalty += 3;
  if (recent10BarMove > 25) penalty += 3;

  const swingSetupScore = round(0.6 * trendScore + 0.4 * pullbackScore - penalty, 2);
  (q as YahooQuote & { _swingSetupScore: number })._swingSetupScore = swingSetupScore;
  (q as YahooQuote & { _trendScore: number })._trendScore = trendScore;
  (q as YahooQuote & { _pullbackScore: number })._pullbackScore = pullbackScore;
  (q as YahooQuote & { _extensionPenalty: number })._extensionPenalty = penalty;
  return swingSetupScore;
}

// ── Pass 2: FA-grade prompt analysis ────────────────────
// Uses the IDENTICAL prompt format as Full Analysis (scenarios, entry/stop/target,
// rationale) which forces the AI to reason through bull/bear/neutral cases before
// committing to a signal. Data pipeline stays efficient (15min for day, daily Yahoo
// for swing) but the rich prompt eliminates scanner↔FA signal divergence.

// FA prompt templates — identical to trading-signals/index.ts
const FA_DAY_USER = `Inputs: (1) Pre-computed indicators (primary), (2) 1m/15m/1h candles (validation), (3) News headlines (confirmation only).

${DAY_TRADE_RULES}

${DAY_TRADE_STRUCTURE_REQUIREMENTS}

Output (STRICT JSON only, no markdown):
{"mode":"DAY_TRADE","recommendation":"BUY"|"SELL"|"HOLD","bias":"short phrase","entryPrice":number|null,"stopLoss":number|null,"targetPrice":number|null,"targetPrice2":number|null,"riskReward":"1:x"|null,"rationale":{"technical":"2-3 sentences","sentiment":"1 sentence","risk":"1-2 sentences"},"confidence":0-10,"scenarios":{"bullish":{"probability":0-100,"summary":"1 sentence"},"neutral":{"probability":0-100,"summary":"1 sentence"},"bearish":{"probability":0-100,"summary":"1 sentence"}}}
Scenario probabilities must sum to 100.

---
{{INDICATOR_SUMMARY}}

Candles:
{{TECHNICAL_DATA}}

News:
{{SENTIMENT_DATA}}`;

const FA_SWING_USER = `Inputs: (1) Pre-computed indicators (primary), (2) 4h/1d/1w candles (validation), (3) News headlines (must not contradict technicals).

${SWING_TRADE_RULES}

Output (STRICT JSON only, no markdown):
{"mode":"SWING_TRADE","recommendation":"BUY"|"SELL"|"HOLD","bias":"short phrase","entryPrice":number|null,"stopLoss":number|null,"targetPrice":number|null,"targetPrice2":number|null,"riskReward":"1:x"|null,"rationale":{"technical":"2-3 sentences","sentiment":"1 sentence","risk":"1-2 sentences"},"confidence":0-10,"scenarios":{"bullish":{"probability":0-100,"summary":"1 sentence"},"neutral":{"probability":0-100,"summary":"1 sentence"},"bearish":{"probability":0-100,"summary":"1 sentence"}}}
Scenario probabilities must sum to 100.

---
{{INDICATOR_SUMMARY}}

Candles:
{{TECHNICAL_DATA}}

News:
{{SENTIMENT_DATA}}`;

async function runPass2(
  pass1: AIEval[],
  quoteMap: Map<string, YahooQuote>,
  mode: 'DAY_TRADE' | 'SWING_TRADE',
  geminiKeys: string[],
): Promise<TradeIdea[]> {
  const tickers = pass1.map(e => e.ticker);
  console.log(`[Trade Scanner] Pass 2 (FA-prompt): ${tickers.length} ${mode === 'DAY_TRADE' ? 'day' : 'swing'} candidates...`);

  // ── Shared data: market snapshot + feedback + news + fundamentals ──
  const [marketSnapshot, feedbackCtx, ...newsArrays] = await Promise.all([
    fetchMarketSnapshot(),
    buildFeedbackContext(),
    ...tickers.map(t => fetchYahooNews(t)),
  ]);
  const newsMap = new Map(tickers.map((t, i) => [t, newsArrays[i]]));

  const marketCtxStr = marketSnapshot
    ? `SPY: ${marketSnapshot.spyTrend} | VIX: ${marketSnapshot.vix} (${marketSnapshot.volatility} fear)`
    : undefined;
  const marketCondition: 'trend' | 'chop' | undefined = marketSnapshot
    ? (marketSnapshot.vix < 20 ? 'trend' : 'chop')
    : undefined;
  const pass1ConfMap = new Map(pass1.map(e => [e.ticker, e.confidence]));

  // Fetch fundamentals for all swing tickers in ONE batch
  const fundMap = mode === 'SWING_TRADE'
    ? await fetchFundamentalsBatch(tickers)
    : new Map();

  // ── Data: fetch candles (day = 15min from Twelve Data, swing = reuse daily Yahoo) ──
  const candleMap = new Map<string, { ohlcvBars: OHLCV[]; trimmed: Record<string, unknown> }>();

  if (mode === 'DAY_TRADE') {
    const candleResults = await Promise.all(
      tickers.map(async (ticker) => {
        try {
          const c15m = await fetchCandles(ticker, '15min', 150);
          if (!c15m?.values?.length) return { ticker, data: null };
          const ohlcvBars = c15m.values.map(v => ({
            o: parseFloat(v.open), h: parseFloat(v.high),
            l: parseFloat(v.low), c: parseFloat(v.close),
            v: v.volume ? parseFloat(v.volume) : 0,
          }));
          const trimmed = {
            '15min': c15m.values.slice(0, 40).map(v => ({
              t: v.datetime, o: parseFloat(v.open), h: parseFloat(v.high),
              l: parseFloat(v.low), c: parseFloat(v.close),
              v: v.volume ? parseFloat(v.volume) : 0,
            })),
          };
          return { ticker, data: { ohlcvBars, trimmed } };
        } catch { return { ticker, data: null }; }
      })
    );
    for (const { ticker, data } of candleResults) {
      if (data) candleMap.set(ticker, data);
    }
  } else {
    for (const ticker of tickers) {
      const quote = quoteMap.get(ticker);
      const ohlcvBars = quote?._ohlcvBars ?? null;
      if (ohlcvBars && ohlcvBars.length >= 30) {
        candleMap.set(ticker, {
          ohlcvBars,
          trimmed: { '1day': ohlcvBars.slice(0, 40).map(b => ({ o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })) },
        });
      }
    }
  }

  // ── Run ALL Gemini calls in PARALLEL using FA prompt format ──
  const systemPrompt = mode === 'DAY_TRADE' ? DAY_TRADE_SYSTEM : SWING_TRADE_SYSTEM;
  const faTemplate = mode === 'DAY_TRADE' ? FA_DAY_USER : FA_SWING_USER;

  const evalResults = await Promise.all(
    tickers.map(async (ticker) => {
      const candles = candleMap.get(ticker);
      if (!candles || candles.ohlcvBars.length < 30) {
        console.log(`[Trade Scanner] ${ticker}: insufficient candle data`);
        return null;
      }

      try {
        const indicators = computeAllIndicators(candles.ohlcvBars);
        const currentPrice = candles.ohlcvBars[0]?.c ?? rawVal(quoteMap.get(ticker)?.regularMarketPrice);
        const indicatorText = formatIndicatorsForPrompt(indicators, currentPrice, marketCtxStr);

        let extraContext = '';
        if (mode === 'SWING_TRADE') {
          const fund = fundMap.get(ticker);
          if (fund) extraContext += `\n\nFundamentals: ${formatFundamentalsForAI(fund)}`;
        }

        const news = newsMap.get(ticker) ?? [];
        const newsForPrompt = news.length > 0
          ? news.map(n => ({ headline: n.headline, source: n.source }))
          : [{ headline: 'No recent news available', source: '' }];

        const technicalData = { timeframes: candles.trimmed, currentPrice };

        // Use the FULL FA prompt — forces scenario analysis + entry/stop/target
        const userPrompt = faTemplate
          .replace('{{INDICATOR_SUMMARY}}', indicatorText + extraContext + feedbackCtx)
          .replace('{{TECHNICAL_DATA}}', JSON.stringify(technicalData))
          .replace('{{SENTIMENT_DATA}}', JSON.stringify(newsForPrompt));

        const raw = await callGemini(geminiKeys, systemPrompt, userPrompt, 0.15, 2000);
        const parsed = JSON.parse(cleanJson(raw));

        // Extract recommendation from FA-format response
        const recommendation = parsed.recommendation ?? parsed.signal ?? 'HOLD';
        const confidence = parsed.confidence ?? 0;
        const reason = parsed.rationale?.technical ?? parsed.reason ?? '';

        console.log(`[Trade Scanner] ${ticker}: ${recommendation}/${confidence} (FA-prompt)`);
        return {
          ticker,
          signal: recommendation as AIEval['signal'],
          confidence,
          reason: typeof reason === 'string' ? reason : '',
        } as AIEval;
      } catch (err) {
        console.warn(`[Trade Scanner] ${ticker} Pass 2 failed:`, err);
        return null;
      }
    })
  );

  const results = evalResults.filter((r): r is AIEval => r !== null);

  // ── Market regime bias (SWING only): adjust confidence before final filter ──
  if (mode === 'SWING_TRADE' && results.length > 0) {
    const spyQuote = await fetchChartQuote('SPY');
    if (spyQuote && spyQuote.fiftyDayAverage > 0 && spyQuote.twoHundredDayAverage > 0) {
      const price = spyQuote.regularMarketPrice ?? 0;
      const sma50 = spyQuote.fiftyDayAverage;
      const sma200 = spyQuote.twoHundredDayAverage;
      const spyAbove50 = price > sma50;
      const spyAbove200 = price > sma200;

      for (const e of results) {
        let c = e.confidence;
        if (!spyAbove50 && !spyAbove200) {
          if (e.signal === 'BUY') c -= 1.5;
          else if (e.signal === 'SELL') c += 1;
        } else if (spyAbove50 && spyAbove200) {
          if (e.signal === 'SELL') c -= 1;
        }
        e.confidence = Math.max(0, Math.min(10, c));
      }
      console.log(`[Trade Scanner] SPY regime: above50=${spyAbove50} above200=${spyAbove200} → confidence adjusted`);
    }
  }

  const withDirection = results.filter(e => e.signal === 'BUY' || e.signal === 'SELL');
  // Keep day strict. For swing, fall back to 6 if strict threshold yields no ideas.
  const strictMinConfidence = 7;
  const fallbackMinConfidence = mode === 'SWING_TRADE' ? 6 : strictMinConfidence;
  const strictCandidates = withDirection.filter(e => e.confidence >= strictMinConfidence);
  const selectedCandidates = strictCandidates.length > 0
    ? strictCandidates
    : withDirection.filter(e => e.confidence >= fallbackMinConfidence);

  const ideas = selectedCandidates
    .filter(e => e.signal === 'BUY' || e.signal === 'SELL')
    .map(e => {
      const q = quoteMap.get(e.ticker);
      return q ? buildIdea(e, q, mode, {
        pass1Confidence: pass1ConfMap.get(e.ticker),
        marketCondition,
      }) : null;
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

    // Check if scan data is from a PREVIOUS trading day (needs fresh start)
    const todayET = formatDateToEtIso(new Date());
    const dayScannedDate = dayRow?.scanned_at
      ? formatDateToEtIso(new Date(dayRow.scanned_at))
      : '';
    const swingScannedDate = swingRow?.scanned_at
      ? formatDateToEtIso(new Date(swingRow.scanned_at))
      : '';
    const dayFromPreviousDay = dayScannedDate !== todayET;
    const swingFromPreviousDay = swingScannedDate !== todayET;

    // Day trades: ONLY refresh during market hours — pre-market Yahoo movers are stale
    const needDayRefresh = forceRefresh || (marketOpen && (dayStale || dayFromPreviousDay));
    // Swing trades: refresh in windows, or any market-hour cycle when today's list is empty.
    const swingNeverScanned = !swingRow || swingFromPreviousDay;
    const swingEmpty = (swingRow?.data?.length ?? 0) === 0;
    const needSwingRefresh = forceRefresh ||
      swingNeverScanned ||
      (swingStale && swingWindow) ||
      (marketOpen && swingEmpty);

    console.log(`[Trade Scanner] day=${dayStale ? 'STALE' : 'FRESH'} dayPrevDay=${dayFromPreviousDay} swing=${swingStale ? 'STALE' : 'FRESH'} swingPrevDay=${swingFromPreviousDay} market=${marketOpen ? 'OPEN' : 'CLOSED'} swingWindow=${swingWindow} refreshDay=${needDayRefresh} refreshSwing=${needSwingRefresh}`);

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
    // Start fresh each new trading day — don't carry over yesterday's picks
    let dayIdeas: TradeIdea[] = (dayFromPreviousDay || forceRefresh) ? [] : (dayRow?.data ?? []);
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
      let candidates = [...deduped.values()];

      // Enrich ALL candidates with chart data (needed for InPlayScore + Pass 1 indicators)
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

      // Large-cap: rank by InPlayScore; take top 30, then top 15 for Gemini
      if (largeCapMode && candidates.length > 0) {
        for (const q of candidates) {
          computeInPlayScore(q, candidates);
        }
        candidates = candidates
          .filter(q => (q._inPlayScore ?? -999) > -999)
          .sort((a, b) => (b._inPlayScore ?? -999) - (a._inPlayScore ?? -999))
          .slice(0, 30);
        candidates = candidates.slice(0, 15);
        if (candidates.length > 0) {
          console.log(`[Trade Scanner] Day InPlayScore top 5: ${candidates.slice(0, 5).map(q => `${q.symbol}:${q._inPlayScore?.toFixed(2)}(${q._extensionPenalty ?? 0})`).join(', ')}`);
        }
      } else if (!largeCapMode) {
        candidates = candidates
          .sort((a, b) => Math.abs(rawVal(b.regularMarketChangePercent)) - Math.abs(rawVal(a.regularMarketChangePercent)))
          .slice(0, 15);
      }

      if (candidates.length > 0) {
        const stockData = candidates.map((q, i) => formatQuoteForAI(q, i)).join('\n');
        const prompt = DAY_SCAN_USER.replace('{{STOCK_DATA}}', stockData);

        try {
          // ── Pass 1: Quick scan with lightweight indicators ──
          const raw = await callGemini(GEMINI_KEYS, DAY_TRADE_SYSTEM, prompt, 0.15, 2000);
          const evals: AIEval[] = parseAIJsonArray(raw);
          const quoteMap = new Map(candidates.map(q => [q.symbol, q]));

          const pass1 = evals
            .filter(e => e.signal !== 'SKIP' && e.signal !== 'HOLD' && e.confidence >= 6)
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 5);

          console.log(`[Trade Scanner] Day Pass 1: ${candidates.length} → ${pass1.length} shortlisted (${pass1.map(e => `${e.ticker}:${e.signal}/${e.confidence}`).join(', ')})`);

          // ── Pass 2: Full shared indicator analysis ──
          if (pass1.length > 0) {
            const newIdeas = await runPass2(pass1, quoteMap, 'DAY_TRADE', GEMINI_KEYS);
            // Merge new ideas with existing — don't overwrite the day's earlier picks
            const existingTickers = new Set(dayIdeas.map(d => d.ticker));
            for (const idea of newIdeas) {
              if (existingTickers.has(idea.ticker)) {
                // Update existing idea with fresh data
                const idx = dayIdeas.findIndex(d => d.ticker === idea.ticker);
                if (idx >= 0) dayIdeas[idx] = idea;
              } else {
                dayIdeas.push(idea);
              }
            }
          }
        } catch (err) {
          console.error('[Trade Scanner] Day AI eval failed:', err);
        }
      }

      // Keep day ideas for the full trading day (not just 30 min)
      // They expire at end of day (use longer TTL, scanner refresh logic handles staleness)
      await writeToDB(sb, 'day_trades', dayIdeas, 390);
    }

    // ── Refresh swing trades ──
    // Start fresh each new trading day for swing too — prevents week-old picks lingering
    let swingIdeas: TradeIdea[] = (swingFromPreviousDay || forceRefresh) ? [] : (swingRow?.data ?? []);
    let swingUniverseInfo: { total: number; sources: Record<string, number> } | undefined;
    if (needSwingRefresh) {
      console.log('[Trade Scanner] Refreshing swing trades (dynamic universe)...');
      const { symbols: swingSymbols, sources: swingSources } = await buildDynamicSwingUniverse(sb, portfolioTickers);
      swingUniverseInfo = {
        total: swingSymbols.length,
        sources: Object.fromEntries(Object.entries(swingSources).map(([k, v]) => [k, v.length])),
      };
      const swingQuotes = await fetchSwingQuotes(swingSymbols);
      let candidates = swingQuotes.filter(preSwingFilter);

      // SwingSetupScore pre-ranking: score → sort → top 30 → Pass 1
      if (candidates.length > 0) {
        for (const q of candidates) {
          computeSwingSetupScore(q);
        }
        candidates = candidates
          .filter(q => (q._swingSetupScore ?? -999) > -999)
          .sort((a, b) => (b._swingSetupScore ?? -999) - (a._swingSetupScore ?? -999))
          .slice(0, 30);
        if (candidates.length > 0) {
          console.log(`[Trade Scanner] Swing SwingSetupScore top 5: ${candidates.slice(0, 5).map(q => `${q.symbol}:${q._swingSetupScore?.toFixed(2)}(${q._extensionPenalty ?? 0})`).join(', ')}`);
        }
      }

      if (candidates.length > 0) {
        try {
          // ── Pass 1: Quick scan with lightweight indicators ──
          // Split into batches of 20 to keep AI JSON output manageable
          const SWING_BATCH = 20;
          const evals: AIEval[] = [];
          for (let bi = 0; bi < candidates.length; bi += SWING_BATCH) {
            const batch = candidates.slice(bi, bi + SWING_BATCH);
            const stockData = batch.map((q, i) => formatQuoteForAI(q, bi + i)).join('\n');
            const prompt = SWING_SCAN_USER.replace('{{STOCK_DATA}}', stockData);
            const raw = await callGemini(GEMINI_KEYS, SWING_TRADE_SYSTEM, prompt, 0.15, 3000);
            const batchEvals = parseAIJsonArray(raw);
            evals.push(...batchEvals);
          }
          const quoteMap = new Map(candidates.map(q => [q.symbol, q]));

          // Log ALL Pass 1 results for diagnostics
          const allSignals = evals.map(e => `${e.ticker}:${e.signal}/${e.confidence}`);
          console.log(`[Trade Scanner] Swing Pass 1 ALL (${evals.length}): ${allSignals.join(', ')}`);

          const nonSkip = evals.filter(e => e.signal !== 'SKIP' && e.signal !== 'HOLD').sort((a, b) => b.confidence - a.confidence);
          console.log(`[Trade Scanner] Swing Pass 1 non-SKIP (${nonSkip.length}): ${nonSkip.map(e => `${e.ticker}:${e.signal}/${e.confidence}`).join(', ') || 'none'}`);

          const pass1 = nonSkip
            .filter(e => e.confidence >= 5)
            .slice(0, 8);

          console.log(`[Trade Scanner] Swing Pass 1 → Pass 2 (${pass1.length}): ${pass1.map(e => `${e.ticker}:${e.signal}/${e.confidence}`).join(', ') || 'none'}`);

          // ── Pass 2: Full shared indicator analysis ──
          if (pass1.length > 0) {
            const newIdeas = await runPass2(pass1, quoteMap, 'SWING_TRADE', GEMINI_KEYS);
            // Merge new ideas with existing — don't overwrite earlier picks
            const existingTickers = new Set(swingIdeas.map(d => d.ticker));
            for (const idea of newIdeas) {
              if (existingTickers.has(idea.ticker)) {
                const idx = swingIdeas.findIndex(d => d.ticker === idea.ticker);
                if (idx >= 0) swingIdeas[idx] = idea;
              } else {
                swingIdeas.push(idea);
              }
            }
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
      ...(swingUniverseInfo ? { swingUniverse: swingUniverseInfo } : {}),
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
