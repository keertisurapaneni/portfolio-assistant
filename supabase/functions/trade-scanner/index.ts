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
  computeVWAP,
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
  // Pass 2 FA levels — carried through so auto-trader skips redundant FA re-run
  entryPrice?: number | null;
  stopLoss?: number | null;
  targetPrice?: number | null;
  riskReward?: string | null;
  atr?: number | null;  // from 15m indicators — used to re-anchor levels to live price
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
  // SwingSetupScore debug (swing pre-ranking)
  _swingSetupScore?: number;
  _trendScore?: number;    // 0-10 (day: InPlayScore trendScore; swing: SwingSetupScore trendScore)
  _pullbackScore?: number; // swing pullbackScore 0-10
  _extensionPenalty?: number; // day: InPlayScore ext penalty; swing: SwingSetupScore ext penalty
}

// AI response shape for one stock
interface AIEval {
  ticker: string;
  signal: 'BUY' | 'SELL' | 'SKIP' | 'HOLD';
  entryPrice?: number | null;
  stopLoss?: number | null;
  targetPrice?: number | null;
  riskReward?: string | null;
  atr?: number | null;
  confidence: number;  // 0-10
  reason: string;
}

// ── Track 1 watchlist: always evaluated for key level setups, every day ──
// These are the tickers Somesh (Kay Capitals) watches every morning — the
// highest-liquidity vehicles with the cleanest intraday structure.
// They bypass InPlayScore ranking so they always reach the AI even on flat days.
const SOMESH_WATCHLIST = [
  'SPY', 'QQQ', 'TSLA', 'NVDA', 'PLTR', 'AMD', 'AAPL', 'META', 'MSFT', 'IWM',
];

// ── Day trade core: always included regardless of Yahoo mover lists ──
// These are the highest-volume, most-liquid day trade vehicles. They don't
// need to be in the Yahoo gainers/losers to be worth scanning.
const DAY_CORE = [
  // Mega-cap tech — always liquid, always in play
  'TSLA', 'AMD', 'NVDA', 'AAPL', 'MSFT', 'META', 'AMZN', 'GOOGL',
  // Broad market ETFs — SPY/QQQ for market direction, IWM for small-cap momentum, DIA for Dow
  'SPY', 'QQQ', 'IWM', 'DIA',
  // Sector ETFs — gold (GLD) and bonds (TLT) for macro plays, semis (SOXL/SOXS are too volatile but SMH works)
  'GLD', 'TLT', 'SMH',
  // Other high-volume single names
  'NFLX', 'CRM', 'UBER', 'COIN', 'MSTR',
  // Defense & geopolitical plays — spike on war/conflict news
  'LMT', 'RTX', 'NOC', 'GD',
  // Energy — oil/gas spike on war/supply disruptions
  'CVX', 'XOM', 'COP',
  // Volatility & safe-haven
  'VXX', 'GDX',
  // High-beta momentum names always active in volatile markets
  'PLTR', 'SNOW', 'RKLB',
];

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
  // 4x/day: near open, midday, afternoon, near close
  return (mins >= 9 * 60 + 45 && mins <= 10 * 60 + 15) ||   // ~10:00 AM
         (mins >= 12 * 60 && mins <= 12 * 60 + 30) ||          // ~12:00 PM
         (mins >= 14 * 60 && mins <= 14 * 60 + 30) ||          // ~2:00 PM
         (mins >= 15 * 60 + 30 && mins <= 16 * 60);            // ~3:45 PM
}

function isPreMarketWindow(): boolean {
  const { hour, minute, dayOfWeek } = getETNow();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const mins = hour * 60 + minute;
  // 7:00 AM – 9:25 AM ET — pre-market is active, gap thesis is forming
  return mins >= 7 * 60 && mins <= 9 * 60 + 25;
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

// ── Pre-market gap scanner ───────────────────────────────
//
// Runs 7:00–9:25 AM ET. Fetches pre-market price for DAY_CORE tickers via
// Yahoo chart with includePrePost=true, caches gappers (>1.5% move vs prev close).
// At market open, these are injected as priority candidates in the day trade scan.

interface PreMarketGapper {
  ticker: string;
  gapPct: number;        // vs prev close
  preMarketPrice: number;
  prevClose: number;
  scannedAt: string;
}

async function fetchPreMarketGap(symbol: string): Promise<{ gapPct: number; preMarketPrice: number; prevClose: number } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m&includePrePost=true`;
    const res = await fetch(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta ?? {};
    const prevClose: number = meta.chartPreviousClose ?? meta.regularMarketPreviousClose ?? 0;
    const preMarketPrice: number = meta.preMarketPrice ?? 0;
    if (!preMarketPrice || !prevClose || prevClose === 0) return null;
    const gapPct = ((preMarketPrice - prevClose) / prevClose) * 100;
    return { gapPct, preMarketPrice, prevClose };
  } catch {
    return null;
  }
}

async function runPreMarketGapScan(
  sb: ReturnType<typeof createClient>,
  forceRefresh: boolean,
  portfolioTickers: string[],
): Promise<PreMarketGapper[]> {
  const existing = await readFromDB(sb, 'pre_market_gaps');
  if (!forceRefresh && existing && !isStale(existing)) {
    return existing.data as unknown as PreMarketGapper[];
  }

  // Watch DAY_CORE + current portfolio holdings
  const universe = [...new Set([...DAY_CORE, ...portfolioTickers])];
  const BATCH = 5;
  const gappers: PreMarketGapper[] = [];

  for (let i = 0; i < universe.length; i += BATCH) {
    const batch = universe.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (sym) => {
      const gap = await fetchPreMarketGap(sym);
      if (!gap || Math.abs(gap.gapPct) < 1.5) return null;
      return { ticker: sym, ...gap, scannedAt: new Date().toISOString() } as PreMarketGapper;
    }));
    for (const r of results) { if (r) gappers.push(r); }
  }

  const sorted = gappers.sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));
  console.log(`[Pre-Market Scanner] ${sorted.length} gappers: ${sorted.map(g => `${g.ticker}(${g.gapPct >= 0 ? '+' : ''}${g.gapPct.toFixed(1)}%)`).join(', ')}`);

  // Cache for 30 minutes
  await writeToDB(sb, 'pre_market_gaps', sorted as unknown as TradeIdea[], 30);
  return sorted;
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
const GEMINI_MODELS = ['gemini-2.0-flash-lite', 'gemini-2.0-flash'];

let _geminiKeyIdx = 0;
let _geminiModelIdx = 0;
const _rateLimitedUntil: Map<string, number> = new Map();

// ── Groq fallback ────────────────────────────────────────
// Used when all Gemini keys are rate-limited (429). Free tier, fast.
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

async function callGroq(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  temperature = 0.15,
  maxOutputTokens = 2000,
): Promise<string> {
  const body = JSON.stringify({
    model: GROQ_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature,
    max_tokens: maxOutputTokens,
  });

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body,
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Groq failed: ${res.status} ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

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

  // All Gemini keys exhausted — fall back to Groq
  const groqKey = Deno.env.get('GROQ_API_KEY');
  if (groqKey) {
    console.log('[Trade Scanner] Gemini exhausted, falling back to Groq');
    return callGroq(groqKey, systemPrompt, userPrompt, temperature, maxOutputTokens);
  }

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

// ── Track 1: Key Level Setups ─────────────────────────────
// AI evaluates pre-computed key levels for the core watchlist.
// Entry/stop/target are already set by pure price structure — AI only picks direction.

const TRACK1_SYSTEM = `You are an experienced day trader. For each stock I'll give you pre-computed key levels (resistance above, support below), today's price action, and momentum indicators.

Your job: decide which direction has the edge TODAY.

BUY  = price is likely to break above the resistance trigger (gap up, buyers in control, RSI rising, holding VWAP)
SELL = price is likely to break below the support trigger (bearish pressure, gap down, failing VWAP, RSI falling)
SKIP = price is stuck in the middle of the range with no directional edge — wait

Rules:
- These are TRIGGER-BASED setups: the trade fires only WHEN price hits the trigger, not at current price
- In a clear uptrend (stock above SMA50/SMA200), bias toward BUY setups
- In a downtrend (stock below SMA50/SMA200), bias toward SELL setups
- Strong pre-market gap in one direction strongly favors that direction continuing
- Volume ratio > 1.5x confirms the directional move; < 0.8x = suspect, lower confidence
- Confidence 7-9 = clear setup; 5-6 = marginal; SKIP = genuinely no edge
- Output ONLY valid JSON, no other text`;

const TRACK1_USER_PREFIX = `Evaluate these stocks for key level breakout/breakdown setups today.

Pick BUY (favors long trigger), SELL (favors short trigger), or SKIP (no clear edge).

Return ONLY a JSON array (no markdown, no backticks):
[{"ticker":"X","signal":"BUY"|"SELL"|"SKIP","confidence":0-10,"reason":"1 sentence"}]

Stocks:
`;

// ── Build TradeIdea from AI eval + Yahoo quote ──────────

function buildIdea(
  eval_: AIEval,
  quote: YahooQuote,
  mode: 'DAY_TRADE' | 'SWING_TRADE',
  opts?: { pass1Confidence?: number; marketCondition?: 'trend' | 'chop' },
): TradeIdea | null {
  // Minimum confidence: 6 for day trades, 5 for swing (bear market penalty can push 6→5.5)
  const minConf = mode === 'SWING_TRADE' ? 5 : 6;
  if (eval_.signal === 'SKIP' || eval_.confidence < minConf) return null;
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
    entryPrice: eval_.entryPrice ?? null,
    stopLoss: eval_.stopLoss ?? null,
    targetPrice: eval_.targetPrice ?? null,
    riskReward: eval_.riskReward ?? null,
    atr: eval_.atr ?? null,
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

// ── Track 1: Key Level AI Evaluation ─────────────────────
//
// Converts KeyLevelSetup structs into a text block for the TRACK1 prompt.
// Includes today's price action and indicators so the AI can pick direction.

function formatKeyLevelForAI(setup: KeyLevelSetup, quote: YahooQuote, idx: number): string {
  const changePct = rawVal(quote.regularMarketChangePercent);
  const volume    = rawVal(quote.regularMarketVolume);
  const avgVol    = rawVal(quote.averageDailyVolume10Day);
  const volRatio  = avgVol > 0 ? round(volume / avgVol, 1) : 0;
  const ind       = quote._pass1Indicators;
  const sma50     = rawVal(quote.fiftyDayAverage);
  const sma200    = rawVal(quote.twoHundredDayAverage);

  const longRR  = setup.longT1 > setup.longTrigger && setup.longTrigger > setup.longStop
    ? round((setup.longT1 - setup.longTrigger) / (setup.longTrigger - setup.longStop), 1) : 0;
  const shortRR = setup.shortTrigger > setup.shortT1 && setup.shortStop > setup.shortTrigger
    ? round((setup.shortTrigger - setup.shortT1) / (setup.shortStop - setup.shortTrigger), 1) : 0;

  const parts = [
    `${idx + 1}. ${setup.ticker} ($${round(setup.price)}) | ATR $${setup.atr}`,
    `Today: ${changePct >= 0 ? '+' : ''}${round(changePct, 1)}%, Vol ${(volume / 1e6).toFixed(1)}M (${volRatio}x avg)`,
    `Key levels: ${setup.levelContext}`,
    `LONG trigger: break above $${setup.longTrigger} → stop $${setup.longStop}, T1 $${setup.longT1}${setup.longT2 ? `, T2 $${setup.longT2}` : ''} (R:R ${longRR}:1)`,
    `SHORT trigger: break below $${setup.shortTrigger} → stop $${setup.shortStop}, T1 $${setup.shortT1}${setup.shortT2 ? `, T2 $${setup.shortT2}` : ''} (R:R ${shortRR}:1)`,
  ];

  if (ind?.rsi14 != null) {
    const rsiLabel = ind.rsi14 >= 70 ? ' (overbought)' : ind.rsi14 <= 30 ? ' (oversold)' : '';
    parts.push(`RSI: ${ind.rsi14}${rsiLabel}`);
  }
  if (ind?.macdHistogram != null) parts.push(`MACD hist: ${ind.macdHistogram > 0 ? '+' : ''}${ind.macdHistogram}`);
  if (sma50  > 0) parts.push(`SMA50: $${round(sma50)} (${setup.price > sma50 ? 'above' : 'below'})`);
  if (sma200 > 0) parts.push(`SMA200: $${round(sma200)} (${setup.price > sma200 ? 'above' : 'below'})`);

  return parts.join(' | ');
}

// Fetch quotes for Track 1 evaluation — fetches SOMESH_WATCHLIST and any
// near-level setups that weren't already in the day scan candidate pool.
async function runTrack1KeyLevelIdeas(
  keyLevelSetups: KeyLevelSetup[],
  geminiKeys: string[],
): Promise<TradeIdea[]> {
  if (keyLevelSetups.length === 0) return [];

  // Always include SOMESH_WATCHLIST; add others if price is within 1.5× ATR of a trigger.
  const relevant = keyLevelSetups.filter(s => {
    if (SOMESH_WATCHLIST.includes(s.ticker)) return true;
    const distLong  = Math.abs(s.price - s.longTrigger);
    const distShort = Math.abs(s.price - s.shortTrigger);
    return Math.min(distLong, distShort) < s.atr * 1.5;
  });

  if (relevant.length === 0) return [];

  // Fetch live quote data for each relevant ticker (needed for RSI/MACD/vol context).
  const quotes = await fetchSwingQuotes(relevant.map(s => s.ticker));
  const quoteMap = new Map(quotes.map(q => [q.symbol, q]));

  const stockData = relevant
    .map((s, i) => {
      const q = quoteMap.get(s.ticker);
      return q ? formatKeyLevelForAI(s, q, i) : `${i + 1}. ${s.ticker} ($${s.price}) | ${s.levelContext}`;
    })
    .join('\n');

  try {
    const raw = await callGemini(geminiKeys, TRACK1_SYSTEM, TRACK1_USER_PREFIX + stockData, 0.15, 1500);
    const evals = parseAIJsonArray(raw);

    console.log(`[Track 1] AI raw (${relevant.length} setups): ${evals.map(e => `${e.ticker}:${e.signal}/${e.confidence}`).join(', ')}`);

    const ideas: TradeIdea[] = [];
    for (const ev of evals) {
      if (ev.signal === 'SKIP' || ev.signal === 'HOLD' || ev.confidence < 6) continue;
      const setup = relevant.find(s => s.ticker === ev.ticker);
      if (!setup) continue;

      const isLong = ev.signal === 'BUY';
      const isSell = ev.signal === 'SELL';
      if (!isLong && !isSell) continue;

      const entry  = isLong ? setup.longTrigger  : setup.shortTrigger;
      const stop   = isLong ? setup.longStop     : setup.shortStop;
      const t1     = isLong ? setup.longT1       : setup.shortT1;
      const t2     = isLong ? setup.longT2       : setup.shortT2;
      const rrNum  = entry !== stop && t1 !== entry
        ? round(Math.abs(t1 - entry) / Math.abs(entry - stop), 1) : 0;

      const q = quoteMap.get(setup.ticker);
      ideas.push({
        ticker:        setup.ticker,
        name:          setup.name,
        price:         round(setup.price),
        change:        q ? round(rawVal(q.regularMarketChange)) : 0,
        changePercent: q ? round(rawVal(q.regularMarketChangePercent), 1) : 0,
        signal:        isLong ? 'BUY' : 'SELL',
        confidence:    Math.max(0, Math.min(10, Math.round(ev.confidence))),
        reason:        ev.reason,
        tags:          ['key-level', ...(SOMESH_WATCHLIST.includes(setup.ticker) ? ['watchlist'] : [])],
        mode:          'DAY_TRADE',
        entryPrice:    entry,
        stopLoss:      stop,
        targetPrice:   t1,
        riskReward:    rrNum > 0 ? `1:${rrNum}` : null,
        atr:           setup.atr,
      });
    }

    console.log(`[Track 1] ${relevant.length} setups → ${ideas.length} ideas (${ideas.map(d => `${d.ticker}:${d.signal}/${d.confidence}`).join(', ') || 'none'})`);
    return ideas;
  } catch (err) {
    console.error('[Track 1] AI eval failed:', err);
    return [];
  }
}

// ── Key Level Scanner ────────────────────────────────────
//
// No AI. Pure price structure.
// For each stock: identify the nearest resistance above and support below
// using prev-day high/low, 5-day range, SMAs, 52w extremes, and round numbers.
// Output: both a long trigger (break above) and short trigger (break below),
// with stops and targets. Let price pick a side — no directional bias.

export interface KeyLevelSetup {
  ticker: string;
  name: string;
  price: number;
  atr: number;
  longTrigger: number;
  longStop: number;
  longT1: number;
  longT2: number | null;
  shortTrigger: number;
  shortStop: number;
  shortT1: number;
  shortT2: number | null;
  levelContext: string;     // human-readable label for the levels
  setupScore: number;       // 0-10 quality score
  dollarVolume: number;
}

interface RawKeyLevel {
  price: number;
  strength: number; // 1-5
  label: string;
}

interface ClusteredLevel {
  price: number;
  strength: number;
  labels: string[];
}

function findNearbyRoundNumbers(price: number, atr: number): number[] {
  const radius = Math.max(atr * 1.5, price * 0.015);
  const results = new Set<number>();

  let granularities: number[];
  if (price < 20) granularities = [1, 5];
  else if (price < 50) granularities = [5, 10];
  else if (price < 100) granularities = [5, 10, 25];
  else if (price < 200) granularities = [10, 25, 50];
  else if (price < 500) granularities = [25, 50, 100];
  else if (price < 1000) granularities = [50, 100, 250];
  else granularities = [100, 250, 500];

  for (const g of granularities) {
    const start = Math.ceil((price - radius) / g) * g;
    const end = Math.floor((price + radius) / g) * g;
    for (let n = start; n <= end; n += g) {
      if (n > 0 && Math.abs(n - price) > 0.01) results.add(round(n, 2));
    }
  }
  return [...results];
}

function clusterKeyLevels(levels: RawKeyLevel[], clusterRadius: number): ClusteredLevel[] {
  if (levels.length === 0) return [];
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const clusters: ClusteredLevel[] = [];
  let cur: ClusteredLevel = { price: sorted[0].price, strength: sorted[0].strength, labels: [sorted[0].label] };

  for (let i = 1; i < sorted.length; i++) {
    const l = sorted[i];
    if (Math.abs(l.price - cur.price) <= clusterRadius) {
      const total = cur.strength + l.strength;
      cur.price = round((cur.price * cur.strength + l.price * l.strength) / total, 2);
      cur.strength = Math.min(cur.strength + l.strength, 8);
      if (!cur.labels.includes(l.label)) cur.labels.push(l.label);
    } else {
      clusters.push(cur);
      cur = { price: l.price, strength: l.strength, labels: [l.label] };
    }
  }
  clusters.push(cur);
  return clusters;
}

function buildKeyLevelSetup(quote: YahooQuote): KeyLevelSetup | null {
  const price = rawVal(quote.regularMarketPrice);
  const ohlcv = quote._ohlcvBars ?? [];
  if (!price || price < 5 || ohlcv.length < 5) return null;

  // ATR from last 14 complete daily bars (ohlcv is newest-first: index 0 = today)
  const recentBars = ohlcv.slice(0, 15);
  const recentBarsOldestFirst = recentBars.slice().reverse();
  const atr = computeATR_pass1(
    recentBarsOldestFirst.map(b => b.h),
    recentBarsOldestFirst.map(b => b.l),
    recentBarsOldestFirst.map(b => b.c),
  ) ?? (price * 0.02);

  const rawLevels: RawKeyLevel[] = [];

  // ── Previous day high/low (most reliable level) ──
  // Skip index 0 (today's potentially partial bar); take next 5 complete bars
  const prevBars = ohlcv.slice(1, 6); // last 5 complete bars (newest-first)
  if (prevBars.length > 0) {
    const yest = prevBars[0]; // index 0 = most recent complete bar = yesterday
    if (yest.h > 0) rawLevels.push({ price: yest.h, strength: 4, label: 'Prev High' });
    if (yest.l > 0) rawLevels.push({ price: yest.l, strength: 4, label: 'Prev Low' });
  }

  // ── 5-day range ──
  if (prevBars.length >= 4) {
    const w5High = Math.max(...prevBars.map(b => b.h));
    const w5Low  = Math.min(...prevBars.map(b => b.l));
    const prevHigh = prevBars[0]?.h ?? 0; // prevBars[0] = yesterday (newest-first)
    const prevLow  = prevBars[0]?.l ?? 0;
    // Only add if different from yesterday's level (to avoid duplicates pre-clustering)
    if (w5High > 0 && Math.abs(w5High - prevHigh) > atr * 0.1)
      rawLevels.push({ price: w5High, strength: 3, label: '5D High' });
    if (w5Low > 0 && Math.abs(w5Low - prevLow) > atr * 0.1)
      rawLevels.push({ price: w5Low, strength: 3, label: '5D Low' });
  }

  // ── SMAs (only if price is close — they ARE the level) ──
  const sma50  = rawVal(quote.fiftyDayAverage);
  const sma200 = rawVal(quote.twoHundredDayAverage);
  if (sma50  > 0 && Math.abs(sma50  - price) < atr * 2)
    rawLevels.push({ price: round(sma50, 2),  strength: 3, label: 'SMA50' });
  if (sma200 > 0 && Math.abs(sma200 - price) < atr * 3)
    rawLevels.push({ price: round(sma200, 2), strength: 4, label: 'SMA200' });

  // ── 52-week extremes (major institutional levels) ──
  const h52 = rawVal(quote.fiftyTwoWeekHigh);
  const l52 = rawVal(quote.fiftyTwoWeekLow);
  if (h52 > 0 && Math.abs(h52 - price) < atr * 2.5)
    rawLevels.push({ price: round(h52, 2), strength: 5, label: '52W High' });
  if (l52 > 0 && Math.abs(l52 - price) < atr * 2.5)
    rawLevels.push({ price: round(l52, 2), strength: 5, label: '52W Low' });

  // ── Round numbers (psychological — where options/stops cluster) ──
  const roundNums = findNearbyRoundNumbers(price, atr);
  for (const rn of roundNums) {
    rawLevels.push({ price: rn, strength: 2, label: `$${rn}` });
  }

  // ── Cluster nearby levels (0.35 ATR = same zone) ──
  const clustered = clusterKeyLevels(rawLevels, atr * 0.35);

  // Minimum gap from current price before a level is "valid"
  const minDist = Math.max(price * 0.001, atr * 0.15);

  const resistances = clustered.filter(c => c.price > price + minDist).sort((a, b) => a.price - b.price);
  const supports    = clustered.filter(c => c.price < price - minDist).sort((a, b) => b.price - a.price);

  if (resistances.length === 0 || supports.length === 0) return null;

  const nearestR = resistances[0];
  const nearestS = supports[0];

  // Range between triggers must be meaningful but not absurd
  const triggerGap = nearestR.price - nearestS.price;
  if (triggerGap < atr * 0.4 || triggerGap > atr * 6) return null;

  // Entry triggers: tiny buffer past the level to confirm breakout
  const longTrigger  = round(nearestR.price * 1.001, 2);
  const shortTrigger = round(nearestS.price * 0.999, 2);

  // Stops: 0.7 ATR inside the trigger (tight but not noise-prone)
  const longStop  = round(longTrigger  - atr * 0.7, 2);
  const shortStop = round(shortTrigger + atr * 0.7, 2);

  // Targets: next significant level, or ATR-based fallback
  const longT1  = resistances[1] ? round(resistances[1].price, 2) : round(longTrigger  + atr * 1.5, 2);
  const longT2  = resistances[2] ? round(resistances[2].price, 2) : null;
  const shortT1 = supports[1]    ? round(supports[1].price, 2)    : round(shortTrigger - atr * 1.5, 2);
  const shortT2 = supports[2]    ? round(supports[2].price, 2)    : null;

  // Require at least 1.3:1 R:R on at least one side
  const longRR  = (longT1  - longTrigger)  / (longTrigger  - longStop);
  const shortRR = (shortTrigger - shortT1) / (shortStop    - shortTrigger);
  if (longRR < 1.3 && shortRR < 1.3) return null;

  // Level context — concise label for UI
  const rLabel = nearestR.labels.join('+');
  const sLabel = nearestS.labels.join('+');
  const levelContext = `${rLabel} $${nearestR.price} | ${sLabel} $${nearestS.price}`;

  // Score: level strength (max 8 each) + bonus for T2 targets, normalized 0-10
  const rawScore = (nearestR.strength + nearestS.strength) / 2 + (longT2 ? 0.5 : 0) + (shortT2 ? 0.5 : 0);
  const setupScore = round(Math.min(10, rawScore * 1.2), 1);

  const avgVol    = rawVal(quote.averageDailyVolume10Day);
  const todayVol  = rawVal(quote.regularMarketVolume);
  const dollarVolume = price * Math.max(avgVol, todayVol);

  return {
    ticker: quote.symbol ?? '',
    name: quote.longName ?? quote.shortName ?? quote.symbol ?? '',
    price,
    atr: round(atr, 2),
    longTrigger,
    longStop,
    longT1,
    longT2,
    shortTrigger,
    shortStop,
    shortT1,
    shortT2,
    levelContext,
    setupScore,
    dollarVolume,
  };
}

async function runKeyLevelScan(
  sb: ReturnType<typeof createClient>,
  forceRefresh: boolean,
): Promise<KeyLevelSetup[]> {
  // Serve from cache if fresh (key levels valid all trading day)
  const existing = await readFromDB(sb, 'key_levels');
  if (!forceRefresh && existing && !isStale(existing)) {
    return existing.data as unknown as KeyLevelSetup[];
  }

  // Universe: always-liquid core + yesterday's high-volume movers
  const universe: string[] = [...DAY_CORE];
  try {
    const [gainers, losers, actives] = await Promise.all([
      fetchMovers('day_gainers'),
      fetchMovers('day_losers'),
      fetchMovers('most_actives'),
    ]);
    const liquidMovers = [...gainers, ...losers, ...actives]
      .filter(q => {
        const p   = rawVal(q.regularMarketPrice);
        const vol = rawVal(q.averageDailyVolume10Day);
        return p >= 10 && p * vol >= 100_000_000; // min $100M daily dollar volume
      })
      .map(q => q.symbol!)
      .filter(Boolean);
    for (const s of liquidMovers) {
      if (!universe.includes(s)) universe.push(s);
      if (universe.length >= 45) break;
    }
  } catch { /* movers optional */ }

  // Fetch quotes with full OHLCV bars
  const quotes = await fetchSwingQuotes([...new Set(universe)]);

  const setups: KeyLevelSetup[] = [];
  for (const q of quotes) {
    if (!q.symbol) continue;
    const p      = rawVal(q.regularMarketPrice);
    const avgVol = rawVal(q.averageDailyVolume10Day);
    // Skip illiquid (< $50M daily dollar vol)
    if (p < 5 || p * avgVol < 50_000_000) continue;
    const setup = buildKeyLevelSetup(q);
    if (setup) setups.push(setup);
  }

  // Sort: liquid first (SPY/QQQ/TSLA at top), then by setup quality
  const sorted = setups
    .sort((a, b) => b.dollarVolume - a.dollarVolume || b.setupScore - a.setupScore)
    .slice(0, 15);

  console.log(`[Key Level Scanner] ${sorted.length} setups from ${quotes.length} stocks`);

  // Cache for 8 hours — levels don't change intraday
  await writeToDB(sb, 'key_levels', sorted as unknown as TradeIdea[], 480);

  return sorted;
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

  // Only penalize genuinely overextended moves (>20%). Stocks up 5-15% are prime
  // day trade candidates and should NOT be suppressed by this penalty.
  const extensionPenalty = Math.max(0, Math.abs(changePct) - 20) * 0.3;
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

const FA_SWING_USER = `Inputs: (1) Pre-computed indicators (primary), (2) 1d daily candles (scanner uses daily only; full analysis also includes 4h/1w), (3) News headlines (must not contradict technicals).

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

  // ── Data: fetch candles ──
  // Day trade: fetch 1min/15min/1h so the LLM can verify VWAP structure on 1m candles
  //            (15min-only was causing direction mismatches vs full analysis)
  // Swing:    reuse daily Yahoo OHLCV from enrichment — zero extra fetches
  const candleMap = new Map<string, { ohlcvBars: OHLCV[]; trimmed: Record<string, unknown>; currentPrice1min?: number }>();

  if (mode === 'DAY_TRADE') {
    const candleResults = await Promise.all(
      tickers.map(async (ticker) => {
        try {
          // Fetch all three intraday timeframes in parallel (short ranges — we only use 40 bars each)
          // 1min: today only (~390 bars max, we take 60) — no need for 7 days of 1m data
          // 15min: 5 days (~130 bars, we take 40) — much less data than 60d default
          // 1h: 5 days (~32 bars) — sufficient for intraday context
          const [c1m, c15m, c1h] = await Promise.all([
            fetchCandles(ticker, '1min', 60, '1d'),
            fetchCandles(ticker, '15min', 60, '5d'),
            fetchCandles(ticker, '1h', 60, '5d'),
          ]);
          if (!c15m?.values?.length) return { ticker, data: null };

          // Indicators use 15min (same as full analysis INDICATOR_INTERVAL['DAY_TRADE'])
          const ohlcvBars = c15m.values.map(v => ({
            o: parseFloat(v.open), h: parseFloat(v.high),
            l: parseFloat(v.low), c: parseFloat(v.close),
            v: v.volume ? parseFloat(v.volume) : 0,
          }));

          const trimmed: Record<string, unknown> = {
            '15min': c15m.values.slice(0, 40).map(v => ({
              t: v.datetime, o: parseFloat(v.open), h: parseFloat(v.high),
              l: parseFloat(v.low), c: parseFloat(v.close),
              v: v.volume ? parseFloat(v.volume) : 0,
            })),
          };

          // Include 1min bars for VWAP/structure analysis (required for BUY/SELL structure gate)
          let currentPrice1min: number | undefined;
          if (c1m?.values?.length) {
            trimmed['1min'] = c1m.values.slice(0, 40).map(v => ({
              t: v.datetime, o: parseFloat(v.open), h: parseFloat(v.high),
              l: parseFloat(v.low), c: parseFloat(v.close),
              v: v.volume ? parseFloat(v.volume) : 0,
            }));
            const p = parseFloat(c1m.values[0].close);
            if (!Number.isNaN(p)) currentPrice1min = p;
          }

          // Include 1h bars for broader intraday context
          if (c1h?.values?.length) {
            trimmed['1h'] = c1h.values.slice(0, 40).map(v => ({
              t: v.datetime, o: parseFloat(v.open), h: parseFloat(v.high),
              l: parseFloat(v.low), c: parseFloat(v.close),
              v: v.volume ? parseFloat(v.volume) : 0,
            }));
          }

          return { ticker, data: { ohlcvBars, trimmed, currentPrice1min } };
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
        // Use 1min close for current price when available (most accurate); fall back to 15min
        const currentPrice = candles.currentPrice1min ?? candles.ohlcvBars[0]?.c ?? rawVal(quoteMap.get(ticker)?.regularMarketPrice);

        // Inject VWAP from 1m bars for day trades (VWAP is an intraday anchor — not available on 15m)
        if (mode === 'DAY_TRADE') {
          const raw1m = candles.trimmed['1min'] as Array<{ o: number; h: number; l: number; c: number; v: number }> | undefined;
          if (raw1m && raw1m.length > 0) {
            const bars1m: OHLCV[] = raw1m.map(b => ({ o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
            indicators.vwap = computeVWAP(bars1m);
          }
        }

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
        // Carry FA levels so auto-trader skips redundant re-run
        const entryPrice = typeof parsed.entryPrice === 'number' ? parsed.entryPrice : null;
        const stopLoss = typeof parsed.stopLoss === 'number' ? parsed.stopLoss : null;
        const targetPrice = typeof parsed.targetPrice === 'number' ? parsed.targetPrice : null;
        const riskReward = typeof parsed.riskReward === 'string' ? parsed.riskReward : null;

        console.log(`[Trade Scanner] ${ticker}: ${recommendation}/${confidence} entry=${entryPrice} stop=${stopLoss} target=${targetPrice} (FA-prompt)`);
        return {
          ticker,
          signal: recommendation as AIEval['signal'],
          confidence,
          reason: typeof reason === 'string' ? reason : '',
          entryPrice, stopLoss, targetPrice, riskReward,
          atr: indicators.atr ?? null,
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
          // Bear market: mild penalty on BUYs (was -1.5, too aggressive — killed all swing BUYs)
          // Quality pullbacks to support in bear markets are some of the best swing entries
          if (e.signal === 'BUY') c -= 0.5;
          else if (e.signal === 'SELL') c += 0.5;
        } else if (spyAbove50 && spyAbove200) {
          if (e.signal === 'SELL') c -= 0.5;
        }
        e.confidence = Math.max(0, Math.min(10, c));
      }
      console.log(`[Trade Scanner] SPY regime: above50=${spyAbove50} above200=${spyAbove200} → confidence adjusted`);
    }
  }

  const withDirection = results.filter(e => e.signal === 'BUY' || e.signal === 'SELL');
  // Day trades: use 6 as base (scanner already did 2 passes of vetting; 7 was too strict)
  // Swing trades: try 7 first, fall back to 5 if nothing qualifies
  // Bear market penalty (-0.5 on BUYs) can push a 6.0 AI score to 5.5 — fallback must reach 5
  const strictMinConfidence = 7;
  const baseMinConfidence = mode === 'DAY_TRADE' ? 6 : strictMinConfidence;
  const fallbackMinConfidence = mode === 'DAY_TRADE' ? 6 : 5;
  const strictCandidates = withDirection.filter(e => e.confidence >= baseMinConfidence);
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
    .slice(0, 8);

  // Swing diagnostics: log signals + confident (logging only)
  if (mode === 'SWING_TRADE' && (withDirection.length > 0 || strictCandidates.length > 0)) {
    try {
      const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const sb = getSupabase();
      await sb.rpc('upsert_swing_metrics', {
        p_date: date,
        p_swing_signals: withDirection.length,
        p_swing_confident: strictCandidates.length,
      });
    } catch (e) {
      console.warn('[Trade Scanner] Swing metrics log failed:', e);
    }
  }

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
    let debugMode = false;
    let diagnosticsMode = false;
    let scanType: 'auto' | 'day' | 'swing' = 'auto'; // 'swing' bypasses day-freshness check
    try {
      const body = await req.json();
      if (Array.isArray(body?.portfolioTickers)) {
        portfolioTickers = body.portfolioTickers
          .map((t: unknown) => String(t).trim().toUpperCase())
          .filter((t: string) => t.length > 0 && t.length <= 10);
      }
      if (body?.forceRefresh === true) forceRefresh = true;
      if (body?._debug === true) debugMode = true;
      if (body?._diagnostics === true) diagnosticsMode = true;
      if (body?.scanType === 'day' || body?.scanType === 'swing') scanType = body.scanType;
    } catch { /* no body */ }

    // ── Diagnostics mode: test Yahoo Finance + Gemini connectivity ──
    if (diagnosticsMode) {
      const diagKeys: string[] = [];
      const diagPrimary = Deno.env.get('GEMINI_API_KEY');
      if (diagPrimary) diagKeys.push(diagPrimary);
      for (let i = 2; ; i++) { const k = Deno.env.get(`GEMINI_API_KEY_${i}`); if (!k) break; diagKeys.push(k); }

      const [moverRes, chartRes, ...geminiResults] = await Promise.all([
        fetch('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&scrIds=day_gainers&start=0&count=3&lang=en-US&region=US', { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(8_000) }).then(async r => ({ status: r.status, ok: r.ok, quoteCount: r.ok ? ((await r.json())?.finance?.result?.[0]?.quotes?.length ?? 0) : 0 })).catch(e => ({ status: -1, error: String(e) })),
        fetch('https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=5d&interval=1d&includePrePost=false', { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(8_000) }).then(r => ({ status: r.status, ok: r.ok })).catch(e => ({ status: -1, error: String(e) })),
        ...GEMINI_MODELS.map(model =>
          fetch(`${GEMINI_BASE}/${model}:generateContent?key=${diagKeys[0] ?? ''}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say OK' }] }], generationConfig: { maxOutputTokens: 5, thinkingConfig: { thinkingBudget: 0 } } }),
            signal: AbortSignal.timeout(10_000),
          }).then(async r => ({ model, status: r.status, ok: r.ok, body: r.ok ? '' : (await r.text()).slice(0, 200) })).catch(e => ({ model, status: -1, error: String(e) }))
        ),
      ]);
      return new Response(JSON.stringify({ screener: moverRes, chart: chartRes, gemini: geminiResults, keyCount: diagKeys.length }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

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

    // ── Key Level scan (always run — no market hours restriction) ──
    const keyLevelSetups = await runKeyLevelScan(sb, forceRefresh);

    const dayStale = isStale(dayRow);
    const swingStale = isStale(swingRow);
    const marketOpen = isMarketOpen();
    const preMarket = isPreMarketWindow();
    const swingWindow = isSwingRefreshWindow();

    // ── Pre-market gap scan (7–9:25 AM ET) ──
    // Run silently in the background — populates cache for market open injection.
    if (preMarket || forceRefresh) {
      runPreMarketGapScan(sb, forceRefresh, portfolioTickers).catch(e =>
        console.warn('[Pre-Market Scanner] Failed:', e)
      );
    }

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
    const needDayRefresh = scanType === 'swing' ? false
      : forceRefresh || (marketOpen && (dayStale || dayFromPreviousDay));
    // Swing trades: refresh in windows, or any market-hour cycle when today's list is empty.
    const swingNeverScanned = !swingRow || swingFromPreviousDay;
    const swingEmpty = (swingRow?.data?.length ?? 0) === 0;

    // Never run both heavy scans in the same call — each scan (day + swing) does 10+ API calls
    // and 2 Gemini passes, which together exceed Supabase Edge Function compute limits.
    // scanType='swing' forces swing regardless of day freshness (used by the 2nd frontend call).
    const needSwingRefresh = scanType === 'swing' ? true
      : !needDayRefresh && (
        forceRefresh ||
        swingNeverScanned ||
        (swingStale && swingWindow) ||
        (marketOpen && swingEmpty)
      );

    console.log(`[Trade Scanner] day=${dayStale ? 'STALE' : 'FRESH'} dayPrevDay=${dayFromPreviousDay} swing=${swingStale ? 'STALE' : 'FRESH'} swingPrevDay=${swingFromPreviousDay} market=${marketOpen ? 'OPEN' : 'CLOSED'} swingWindow=${swingWindow} refreshDay=${needDayRefresh} refreshSwing=${needSwingRefresh}`);

    if (!needDayRefresh && !needSwingRefresh) {
      const cachedGapRow = await readFromDB(sb, 'pre_market_gaps');
      return new Response(JSON.stringify({
        dayTrades: dayRow?.data ?? [],
        swingTrades: swingRow?.data ?? [],
        keyLevelSetups,
        preMarketGappers: (cachedGapRow?.data ?? []) as unknown as PreMarketGapper[],
        timestamp: Date.now(),
        cached: true,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (GEMINI_KEYS.length === 0) {
      console.warn('[Trade Scanner] No Gemini keys — returning cached data');
      const cachedGapRow = await readFromDB(sb, 'pre_market_gaps');
      return new Response(JSON.stringify({
        dayTrades: dayRow?.data ?? [],
        swingTrades: swingRow?.data ?? [],
        keyLevelSetups,
        preMarketGappers: (cachedGapRow?.data ?? []) as unknown as PreMarketGapper[],
        timestamp: Date.now(),
        cached: true,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── Refresh day trades ──
    // Start fresh each new trading day — don't carry over yesterday's picks
    let dayIdeas: TradeIdea[] = (dayFromPreviousDay || forceRefresh) ? [] : (dayRow?.data ?? []);
    if (needDayRefresh) {
      console.log('[Trade Scanner] Refreshing day trades...');
      const [gainers, losers, actives] = await Promise.all([
        fetchMovers('day_gainers'),
        fetchMovers('day_losers'),
        fetchMovers('most_actives'),
      ]);
      if (debugMode) console.log(`[Debug] movers: gainers=${gainers.length} losers=${losers.length} actives=${actives.length}`);

      // most_actives uses a looser filter (volume surge enough — don't need 1% move)
      const activeFiltered = actives.filter(q => {
        const price = rawVal(q.regularMarketPrice);
        const vol = rawVal(q.regularMarketVolume);
        const avgVol = rawVal(q.averageDailyVolume10Day);
        return price >= 10 && vol >= 2_000_000 && (avgVol > 0 ? vol / avgVol >= 1.3 : false);
      });

      const allMovers = [...gainers, ...losers, ...activeFiltered].filter(preDayFilter);
      const deduped = new Map<string, YahooQuote>();
      for (const q of allMovers) {
        const sym = q.symbol;
        if (!deduped.has(sym) || Math.abs(rawVal(q.regularMarketChangePercent)) > Math.abs(rawVal(deduped.get(sym)!.regularMarketChangePercent))) {
          deduped.set(sym, q);
        }
      }

      // Inject DAY_CORE tickers not already in the mover list (looser filter: just price+volume)
      const coreMissing = DAY_CORE.filter(sym => !deduped.has(sym));
      if (coreMissing.length > 0) {
        const coreQuotes = await fetchSwingQuotes(coreMissing);
        for (const q of coreQuotes) {
          if (!q.symbol) continue;
          const price = rawVal(q.regularMarketPrice);
          const volume = rawVal(q.regularMarketVolume);
          if (price >= 10 && volume >= 1_000_000) {
            deduped.set(q.symbol, q);
          }
        }
        console.log(`[Trade Scanner] DAY_CORE injected: ${coreQuotes.map(q => q.symbol).filter(Boolean).join(', ')}`);
      }

      // Inject pre-market gappers — non-DAY_CORE stocks that were gapping pre-market
      // These are the best gap-and-go setups: known movers at 9:30 open.
      const preMarketRow = await readFromDB(sb, 'pre_market_gaps');
      if (preMarketRow && !isStale(preMarketRow) && preMarketRow.data.length > 0) {
        const gappers = preMarketRow.data as unknown as PreMarketGapper[];
        const gapTickers = gappers.map(g => g.ticker).filter(t => !deduped.has(t));
        if (gapTickers.length > 0) {
          const gapQuotes = await fetchSwingQuotes(gapTickers);
          for (const q of gapQuotes) {
            if (!q.symbol) continue;
            const price = rawVal(q.regularMarketPrice);
            const volume = rawVal(q.regularMarketVolume);
            if (price >= 10 && volume >= 500_000) {
              deduped.set(q.symbol, q);
            }
          }
          console.log(`[Trade Scanner] Pre-market gappers injected: ${gapTickers.join(', ')}`);
        }
      }

      let candidates = [...deduped.values()];
      if (debugMode) console.log(`[Debug] candidates after dedup+core: ${candidates.length} (${candidates.slice(0, 5).map(q => q.symbol).join(',')})`);
      // DAY_CORE tickers are fetched via fetchChartQuote and already have _pass1Indicators.
      // Re-fetching 1y of daily data for all 40+ candidates is the primary compute bottleneck.
      const needEnrichment = candidates.filter(q => !q._pass1Indicators).map(q => q.symbol);
      if (needEnrichment.length > 0) {
        const enrichedQuotes = await fetchSwingQuotes(needEnrichment);
        const enrichMap = new Map(enrichedQuotes.map(q => [q.symbol, q]));
        candidates = candidates.map(q => {
          if (q._pass1Indicators) return q; // Already has chart data from DAY_CORE fetch
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
      }

      // Large-cap: rank by InPlayScore; take top 30, then top 15 for Gemini.
      // SOMESH_WATCHLIST tickers are always re-injected after the cut so they
      // reach the AI even on flat days when their InPlayScore is low.
      if (largeCapMode && candidates.length > 0) {
        for (const q of candidates) {
          computeInPlayScore(q, candidates);
        }
        const preCutCandidates = [...candidates]; // save before slice so we can re-inject
        candidates = candidates
          .filter(q => (q._inPlayScore ?? -999) > -999)
          .sort((a, b) => (b._inPlayScore ?? -999) - (a._inPlayScore ?? -999))
          .slice(0, 30);
        if (candidates.length > 0) {
          console.log(`[Trade Scanner] Day InPlayScore top 5: ${candidates.slice(0, 5).map(q => `${q.symbol}:${q._inPlayScore?.toFixed(2)}(${q._extensionPenalty ?? 0})`).join(', ')}`);
        }
        // Re-inject watchlist tickers that got cut — they're always worth evaluating
        const inSlice = new Set(candidates.map(q => q.symbol));
        for (const sym of SOMESH_WATCHLIST) {
          if (!inSlice.has(sym)) {
            const q = preCutCandidates.find(c => c.symbol === sym);
            if (q) { candidates.push(q); inSlice.add(sym); }
          }
        }
      } else if (!largeCapMode) {
        candidates = candidates
          .sort((a, b) => Math.abs(rawVal(b.regularMarketChangePercent)) - Math.abs(rawVal(a.regularMarketChangePercent)))
          .slice(0, 15);
      }

      let dayAISucceeded = false;
      if (candidates.length > 0) {
        const stockData = candidates.map((q, i) => formatQuoteForAI(q, i)).join('\n');
        const prompt = DAY_SCAN_USER.replace('{{STOCK_DATA}}', stockData);

        try {
          // ── Pass 1: Quick scan with lightweight indicators ──
          const raw = await callGemini(GEMINI_KEYS, DAY_TRADE_SYSTEM, prompt, 0.15, 2000);
          dayAISucceeded = true;
          const evals: AIEval[] = parseAIJsonArray(raw);
          const quoteMap = new Map(candidates.map(q => [q.symbol, q]));

          console.log(`[Trade Scanner] Day Pass 1 raw: ${evals.map(e => `${e.ticker}:${e.signal}/${e.confidence}`).join(', ')}`);

          const pass1 = evals
            .filter(e => e.signal !== 'SKIP' && e.signal !== 'HOLD' && e.confidence >= 5)
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 8); // Groq fallback removes quota constraint — allow up to 8 into Pass 2

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
      } else {
        dayAISucceeded = true; // No candidates = genuinely nothing to scan, safe to cache
      }

      // ── Track 1: Key level setups for core watchlist ──────────────────
      // Runs after the mover scan. Merges key-level ideas into dayIdeas,
      // skipping any tickers already covered by the mover scan above.
      try {
        const track1Ideas = await runTrack1KeyLevelIdeas(keyLevelSetups, GEMINI_KEYS);
        if (track1Ideas.length > 0) {
          const existingTickers = new Set(dayIdeas.map(d => d.ticker));
          for (const idea of track1Ideas) {
            if (!existingTickers.has(idea.ticker)) {
              dayIdeas.push(idea);
              existingTickers.add(idea.ticker);
            }
          }
          console.log(`[Track 1] Merged ${track1Ideas.filter(i => !new Set(dayIdeas.slice(0, dayIdeas.length - track1Ideas.length).map(d => d.ticker)).has(i.ticker)).length} new ideas into day trades`);
        }
      } catch (err) {
        console.error('[Track 1] Failed — continuing without key level ideas:', err);
      }

      // Sort final dayIdeas by confidence descending
      dayIdeas.sort((a, b) => b.confidence - a.confidence);

      // Caching rules:
      // - If we have any ideas (from Track 1, Track 2, or both) → always write to DB
      // - If Track 2 AI failed but Track 1 produced ideas → still write those to DB
      // - Only fall back to previous DB scan if we truly have nothing at all
      if (dayIdeas.length > 0) {
        await writeToDB(sb, 'day_trades', dayIdeas, 390);
      } else if (!dayAISucceeded) {
        console.warn('[Trade Scanner] Day AI failed and Track 1 empty — skipping DB write to preserve previous results');
        dayIdeas = dayRow?.data ?? [];
      } else {
        console.log('[Trade Scanner] Day scan produced 0 ideas — preserving previous scan results');
        dayIdeas = dayRow?.data ?? [];
      }
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

      let swingAISucceeded = false;
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
          swingAISucceeded = true;
          const quoteMap = new Map(candidates.map(q => [q.symbol, q]));

          // Log ALL Pass 1 results for diagnostics
          const allSignals = evals.map(e => `${e.ticker}:${e.signal}/${e.confidence}`);
          console.log(`[Trade Scanner] Swing Pass 1 ALL (${evals.length}): ${allSignals.join(', ')}`);

          const nonSkip = evals.filter(e => e.signal !== 'SKIP' && e.signal !== 'HOLD').sort((a, b) => b.confidence - a.confidence);
          console.log(`[Trade Scanner] Swing Pass 1 non-SKIP (${nonSkip.length}): ${nonSkip.map(e => `${e.ticker}:${e.signal}/${e.confidence}`).join(', ') || 'none'}`);

          const pass1 = nonSkip
            .filter(e => e.confidence >= 4) // lowered from 5 — bear/choppy markets get conservative AI scores
            .slice(0, 10);

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
      } else {
        swingAISucceeded = true; // No candidates = safe to cache
      }

      if (swingAISucceeded) {
        if (swingIdeas.length > 0) {
          await writeToDB(sb, 'swing_trades', swingIdeas, 360);
        } else {
          console.log('[Trade Scanner] Swing scan produced 0 ideas — preserving previous scan results');
          swingIdeas = swingRow?.data ?? [];
        }
      } else {
        console.warn('[Trade Scanner] Swing AI failed — skipping DB write to preserve previous results');
        swingIdeas = swingRow?.data ?? [];
      }
    }

    // When only one scan ran (e.g. day refresh ran but swing was skipped), always use the DB
    // data for the non-refreshed type — swingIdeas/dayIdeas start empty when prevDay is true
    // and would wrongly wipe the UI if we didn't fall back to the DB rows here.
    const preMarketGapRow = await readFromDB(sb, 'pre_market_gaps');
    const preMarketGappers = (preMarketGapRow?.data ?? []) as unknown as PreMarketGapper[];

    return new Response(JSON.stringify({
      dayTrades: dayIdeas,
      swingTrades: needSwingRefresh ? swingIdeas : (swingRow?.data ?? []),
      keyLevelSetups,
      preMarketGappers,
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
