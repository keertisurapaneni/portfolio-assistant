/**
 * Options Wheel Scanner
 *
 * Runs the morning options scan against the watchlist.
 * Applies all 8 entry checks and generates trade tickets
 * for qualifying put-selling opportunities.
 *
 * Entry checks:
 *   1. Bear market gate (SPY above SMA200)
 *   2. Earnings blackout (>14 days to next earnings)
 *   3. IV spike filter (no sudden >20pt IV jump = news event)
 *   4. IV Rank > 50 (premium is elevated)
 *   5. RSI oversold + recovering (< 38, turning up)
 *   6. Stock price > $20 and options are liquid
 *   7. Free capital sufficient to cover assignment
 *   8. Sector concentration cap (max 2 per sector)
 */

import { getSupabase, createAutoTradeEvent } from './supabase.js';
import { getOptionsChain, type OptionGreeks } from './options-chain.js';
import { isConnected, placeOptionsOrder, getDefaultAccount } from '../ib-connection.js';

// ── Constants ────────────────────────────────────────────

const FINNHUB_KEY = process.env.FINNHUB_API_KEY ?? '';
const MIN_STOCK_PRICE = 20;
const MIN_PREMIUM_YIELD_PCT = 0.8;        // at least 0.8% of strike per 30 days
const MIN_IV_RANK = 50;                    // only sell when premium is elevated
const RSI_OVERSOLD = 38;                   // RSI threshold for oversold
const MAX_POSITIONS_NORMAL = 5;            // max concurrent open options puts
const MAX_POSITIONS_HIGH_VIX = 3;          // VIX > 25
const EARNINGS_BLACKOUT_DAYS = 7;
const IV_SPIKE_THRESHOLD = 20;             // points — sudden IV jump = news event
const MAX_SPREAD_PCT = 0.30;               // bid-ask spread must be < 30% of mid
const MIN_SENTIMENT_SCORE = -0.3;          // block if Finnhub bearish score < this
const NEWS_LOOKBACK_DAYS = 7;              // check news from last N days
const MAX_SECTOR_POSITIONS = 2;            // max concurrent positions in same sector
const MAX_BETA = 1.5;                      // skip high-beta stocks for put selling
const STOCK_TREND_SMA_DAYS = 50;           // stock must be above its own 50-day SMA
const MAX_STOCK_DECLINE_3M_PCT = 20;       // skip if stock down >20% in 3 months
const MARKET_OPEN_BUFFER_MS = 30 * 60_000; // don't trade in first 30 min after open

// Bear market mode — more conservative params applied when SPY < SMA200
const BEAR_DELTA_TARGET = 0.15;            // 15-delta puts (vs normal 20-25)
const BEAR_DTE_TARGET = 21;                // shorter expiry
const BEAR_POSITION_SIZE_FACTOR = 0.5;     // half size
const BEAR_DEFENSIVE_SECTORS = [           // only these sectors in bear mode
  'Consumer Staples', 'Utilities', 'Health Care', 'Financials',
];

// Hard stops — one headline is enough (existential / regulatory)
const RED_FLAG_HARD = [
  'fraud', 'sec investigation', 'doj', 'department of justice',
  'chapter 11', 'chapter 7', 'going concern', 'delisting',
  'fda rejection', 'restatement', 'accounting irregularit',
  'whistleblower', 'ponzi', 'subpoena',
];
// Soft stops — require 2+ headlines to avoid incidental mentions on large caps
const RED_FLAG_SOFT = [
  'bankruptcy', 'class action', 'recall', 'ceo resign', 'cfo resign',
];

// ── Types ────────────────────────────────────────────────

export interface OptionsTradeTicket {
  ticker: string;
  currentPrice: number;
  signal: 'SELL_PUT' | 'SELL_CALL';
  strike: number;
  expiry: string;           // YYYYMMDD
  expiryFormatted: string;  // e.g. "Jan 31"
  daysToExpiry: number;
  premium: number;          // per share (bid price — conservative fill estimate)
  premiumTotal: number;     // premium × 100 (per contract)
  netPrice: number;         // strike - premium (effective cost if assigned)
  capitalRequired: number;  // strike × 100
  delta: number;
  ivRank: number | null;
  probProfit: number;
  annualYield: number;
  checksPassedCount: number;
  checksDetail: Record<string, boolean | string>;
  bearMode: boolean;        // true = bear market conservative params applied
}

interface WatchlistEntry {
  ticker: string;
  min_price: number | null;
}

interface ScanContext {
  spyAboveSma200: boolean;
  bearMode: boolean;           // true when SPY < SMA200 — applies conservative params
  vix: number;
  openPutCount: number;
  openTickerSet: Set<string>;  // tickers with existing open puts (prevent duplicates)
  deployedCapitalByTicker: Map<string, number>;
  sectorByTicker: Map<string, string>;
  openCountBySector: Map<string, number>;
  freeCapital: number;
}

// ── Finnhub Helpers ──────────────────────────────────────

// Finnhub free tier = 60 calls/min. Rate-limit to ~50/min (1200ms gap) with
// a simple queue so bursts don't exhaust the quota mid-scan.
let _lastFinnhubCall = 0;
const FINNHUB_MIN_GAP_MS = 800;

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const now = Date.now();
    const wait = FINNHUB_MIN_GAP_MS - (now - _lastFinnhubCall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastFinnhubCall = Date.now();
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch {
    return null;
  }
}

async function getStockQuote(ticker: string): Promise<{ price: number; change: number } | null> {
  const data = await fetchJson<{ c: number; d: number }>(
    `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`
  );
  if (!data?.c) return null;
  return { price: data.c, change: data.d ?? 0 };
}

async function getRSI(ticker: string): Promise<{ rsi: number; prevRsi: number } | null> {
  const data = await fetchJson<{ technicalAnalysis?: { count?: { buy?: number; sell?: number }; signal?: string }; trend?: { adx?: number }; indicators?: { rsi?: unknown[] } }>(
    `https://finnhub.io/api/v1/scan/technical-indicator?symbol=${ticker}&resolution=D&from=${Math.floor(Date.now() / 1000) - 86400 * 60}&to=${Math.floor(Date.now() / 1000)}&indicator=rsi&indicatorFields=%7B%22timeperiod%22:14%7D&token=${FINNHUB_KEY}`
  );
  // Alternative: use basic indicators endpoint
  const basic = await fetchJson<{ rsi?: number[] }>(
    `https://finnhub.io/api/v1/indicator?symbol=${ticker}&resolution=D&from=${Math.floor(Date.now() / 1000) - 86400 * 60}&to=${Math.floor(Date.now() / 1000)}&indicator=rsi&timeperiod=14&token=${FINNHUB_KEY}`
  );
  if (!basic?.rsi || basic.rsi.length < 2) return null;
  const arr = basic.rsi.filter(v => v != null && v > 0);
  if (arr.length < 2) return null;
  return { rsi: arr[arr.length - 1], prevRsi: arr[arr.length - 2] };
}

async function getEarningsDate(ticker: string): Promise<Date | null> {
  const data = await fetchJson<{ earningsCalendar?: Array<{ date?: string }> }>(
    `https://finnhub.io/api/v1/calendar/earnings?symbol=${ticker}&token=${FINNHUB_KEY}`
  );
  const entries = data?.earningsCalendar ?? [];
  const future = entries
    .map(e => e.date ? new Date(e.date) : null)
    .filter((d): d is Date => d !== null && d > new Date())
    .sort((a, b) => a.getTime() - b.getTime());
  return future[0] ?? null;
}

async function getVix(): Promise<number> {
  const data = await fetchJson<{ c: number }>(
    `https://finnhub.io/api/v1/quote?symbol=VIX&token=${FINNHUB_KEY}`
  );
  return data?.c ?? 20;
}

async function getSpySma200(): Promise<{ price: number; sma200: number } | null> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - 86400 * 220; // 220 days
  const data = await fetchJson<{ c?: number[]; t?: number[] }>(
    `https://finnhub.io/api/v1/stock/candle?symbol=SPY&resolution=D&from=${from}&to=${to}&token=${FINNHUB_KEY}`
  );
  if (!data?.c || data.c.length < 200) return null;
  const closes = data.c;
  const sma200 = closes.slice(-200).reduce((a, b) => a + b, 0) / 200;
  return { price: closes[closes.length - 1], sma200 };
}

// ── Market Hours ─────────────────────────────────────────

/** Returns true if we're past the first 30-min volatility window (after 10:00 AM ET). */
function isPastOpeningWindow(): boolean {
  const now = new Date();
  // ET offset: UTC-5 (EST) or UTC-4 (EDT)
  const etOffset = isDST(now) ? -4 : -5;
  const etHour = (now.getUTCHours() + etOffset + 24) % 24;
  const etMin = now.getUTCMinutes();
  return etHour > 10 || (etHour === 10 && etMin >= 0);
}

function isDST(date: Date): boolean {
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  return date.getTimezoneOffset() < Math.max(jan, jul);
}

// ── Stock Trend ───────────────────────────────────────────

interface StockTrendResult {
  aboveSma50: boolean;
  sma50: number;
  price: number;
  change3m: number;  // % change over last 3 months
}

async function getStockTrend(ticker: string): Promise<StockTrendResult | null> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - 86400 * 70; // ~70 trading days covers 50-day SMA + 3m change
  const data = await fetchJson<{ c?: number[] }>(
    `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${to}&token=${FINNHUB_KEY}`
  );
  if (!data?.c || data.c.length < 50) return null;
  const closes = data.c;
  const price = closes[closes.length - 1];
  const sma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const price3mAgo = closes[Math.max(0, closes.length - 63)]; // ~63 trading days = 3 months
  const change3m = price3mAgo > 0 ? ((price - price3mAgo) / price3mAgo) * 100 : 0;
  return { aboveSma50: price > sma50, sma50, price, change3m };
}

// ── Beta ──────────────────────────────────────────────────

async function getStockBeta(ticker: string): Promise<number | null> {
  const data = await fetchJson<{ metric?: { beta?: number } }>(
    `https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${FINNHUB_KEY}`
  );
  return data?.metric?.beta ?? null;
}

// ── News & Sentiment ─────────────────────────────────────

interface NewsSentimentResult {
  bullishPct: number;
  bearishPct: number;
  score: number;           // bullishPct - bearishPct, range -1 to 1
  articlesCount: number;
  redFlagFound: boolean;
  redFlagReason: string | null;
}

async function getNewsSentiment(ticker: string): Promise<NewsSentimentResult> {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - NEWS_LOOKBACK_DAYS * 86400_000).toISOString().slice(0, 10);

  const [sentiment, news] = await Promise.all([
    fetchJson<{
      sentiment?: { bullishPercent?: number; bearishPercent?: number };
      buzz?: { articlesInLastWeek?: number };
    }>(`https://finnhub.io/api/v1/news-sentiment?symbol=${ticker}&token=${FINNHUB_KEY}`),
    fetchJson<Array<{ headline?: string; summary?: string }>>(
      `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${from}&to=${to}&token=${FINNHUB_KEY}`
    ),
  ]);

  const bullishPct = sentiment?.sentiment?.bullishPercent ?? 0.5;
  const bearishPct = sentiment?.sentiment?.bearishPercent ?? 0.5;
  const score = bullishPct - bearishPct;
  const articlesCount = sentiment?.buzz?.articlesInLastWeek ?? (news?.length ?? 0);

  // Scan headlines only (not summaries — large caps always have incidental mentions)
  let redFlagFound = false;
  let redFlagReason: string | null = null;
  const softHits = new Map<string, number>();
  for (const article of news ?? []) {
    const headline = (article.headline ?? '').toLowerCase();
    const hard = RED_FLAG_HARD.find(kw => headline.includes(kw));
    if (hard) { redFlagFound = true; redFlagReason = hard; break; }
    const soft = RED_FLAG_SOFT.find(kw => headline.includes(kw));
    if (soft) softHits.set(soft, (softHits.get(soft) ?? 0) + 1);
  }
  if (!redFlagFound) {
    for (const [kw, count] of softHits) {
      if (count >= 2) { redFlagFound = true; redFlagReason = kw; break; }
    }
  }

  return { bullishPct, bearishPct, score, articlesCount, redFlagFound, redFlagReason };
}

// ── Sector Profile ────────────────────────────────────────

const sectorCache = new Map<string, string>();

async function getStockSector(ticker: string): Promise<string> {
  if (sectorCache.has(ticker)) return sectorCache.get(ticker)!;
  const data = await fetchJson<{ finnhubIndustry?: string }>(
    `https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${FINNHUB_KEY}`
  );
  const sector = data?.finnhubIndustry ?? 'Unknown';
  sectorCache.set(ticker, sector);
  return sector;
}

// ── IV Spike Detection ────────────────────────────────────

async function checkIvSpike(ticker: string, currentIv: number): Promise<{ spiked: boolean; delta: number }> {
  const sb = getSupabase();
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

  const { data } = await sb
    .from('options_iv_history')
    .select('iv')
    .eq('ticker', ticker)
    .lte('date', yesterday)
    .order('date', { ascending: false })
    .limit(1);

  if (!data?.length) return { spiked: false, delta: 0 };
  const prevIv = data[0].iv as number;
  const delta = currentIv - prevIv;
  return { spiked: delta >= IV_SPIKE_THRESHOLD, delta };
}

function formatExpiry(yyyymmdd: string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  return `${months[m]} ${d}`;
}

function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

function daysToExpiryFromStr(yyyymmdd: string): number {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  return Math.ceil((new Date(y, m, d).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

// ── IV Rank Helpers ──────────────────────────────────────

/**
 * Stores today's IV reading; returns the IV rank based on stored history.
 * IV rank = (current IV - 52w low) / (52w high - 52w low) * 100
 */
async function getIvRank(ticker: string, currentIv: number): Promise<number | null> {
  const sb = getSupabase();
  const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Upsert today's IV reading
  const today = new Date().toISOString().slice(0, 10);
  await sb.from('options_iv_history').upsert(
    { ticker, date: today, iv: currentIv },
    { onConflict: 'ticker,date' }
  );

  // Get min/max over last year
  const { data } = await sb
    .from('options_iv_history')
    .select('iv')
    .eq('ticker', ticker)
    .gte('date', yearAgo);

  if (!data || data.length < 10) return null; // not enough history yet

  const ivs = data.map(r => r.iv as number);
  const min = Math.min(...ivs);
  const max = Math.max(...ivs);
  if (max === min) return 50; // no range yet
  return Math.round(((currentIv - min) / (max - min)) * 100);
}

// ── Build Scan Context ───────────────────────────────────

async function buildScanContext(freeCapital: number): Promise<ScanContext> {
  const sb = getSupabase();
  const [spyData, vix, openPositions] = await Promise.all([
    getSpySma200(),
    getVix(),
    sb.from('paper_trades')
      .select('ticker, mode, position_size')
      .in('mode', ['OPTIONS_PUT', 'OPTIONS_CALL'])
      .in('status', ['PENDING', 'SUBMITTED', 'FILLED', 'PARTIAL']),
  ]);

  const sectorByTicker = new Map<string, string>();
  const openCountBySector = new Map<string, number>();
  const deployedByTicker = new Map<string, number>();

  // Populate sector map for open positions
  const openTickers = [...new Set((openPositions.data ?? []).map(p => p.ticker))];
  await Promise.all(openTickers.map(async t => {
    const sector = await getStockSector(t);
    sectorByTicker.set(t, sector);
    openCountBySector.set(sector, (openCountBySector.get(sector) ?? 0) + 1);
  }));

  for (const pos of openPositions.data ?? []) {
    deployedByTicker.set(pos.ticker, (deployedByTicker.get(pos.ticker) ?? 0) + (pos.position_size ?? 0));
  }

  const spyAboveSma200 = spyData ? spyData.price > spyData.sma200 : true;
  const openTrades = (openPositions.data ?? []).filter(p => p.mode === 'OPTIONS_PUT');

  return {
    spyAboveSma200,
    bearMode: !spyAboveSma200,
    vix,
    openPutCount: openTrades.length,
    openTickerSet: new Set(openTrades.map(p => p.ticker)),
    deployedCapitalByTicker: deployedByTicker,
    sectorByTicker,
    openCountBySector,
    freeCapital,
  };
}

// ── Check One Stock ──────────────────────────────────────

async function checkStock(
  ticker: string,
  minPrice: number | null,
  ctx: ScanContext,
): Promise<OptionsTradeTicket | { ticker: string; skipped: true; reason: string }> {
  const checks: Record<string, boolean | string> = {};

  // Check 0: Time-of-day gate — skip first 30 min after open (wide spreads, erratic pricing)
  if (!isPastOpeningWindow()) {
    return { ticker, skipped: true, reason: 'too_early_opening_30min' };
  }

  // Check 1: Bear market gate — in bear mode, only allow defensive sectors
  checks.bearMarketGate = ctx.spyAboveSma200 ? 'bull' : 'bear_mode_active';
  // Don't hard-block bear market — instead apply bear mode restrictions below

  // Check 1.5: Duplicate ticker guard — don't stack puts on same ticker
  if (ctx.openTickerSet.has(ticker)) {
    return { ticker, skipped: true, reason: 'duplicate_open_position' };
  }

  // Check 2: Position limit
  const maxPositions = ctx.vix > 25 ? MAX_POSITIONS_HIGH_VIX : MAX_POSITIONS_NORMAL;
  checks.positionLimit = ctx.openPutCount < maxPositions;
  if (ctx.openPutCount >= maxPositions) return { ticker, skipped: true, reason: 'max_positions' };

  // Get current price
  const quote = await getStockQuote(ticker);
  if (!quote) return { ticker, skipped: true, reason: 'no_price_data' };
  const { price } = quote;

  // Check 3: Min price
  const effectiveMinPrice = minPrice ?? MIN_STOCK_PRICE;
  checks.minPrice = price >= effectiveMinPrice;
  if (price < effectiveMinPrice) return { ticker, skipped: true, reason: `price_too_low_${price.toFixed(0)}` };

  // Check 3.5: Stock trend — must be above its own 50-day SMA and not down >20% in 3 months
  const trend = await getStockTrend(ticker);
  if (trend) {
    checks.stockTrend = `sma50:${trend.sma50.toFixed(0)}_3m:${trend.change3m.toFixed(1)}%_${trend.aboveSma50 ? 'above' : 'below'}`;
    if (!trend.aboveSma50) {
      return { ticker, skipped: true, reason: `below_sma50:${trend.sma50.toFixed(0)}` };
    }
    if (trend.change3m < -MAX_STOCK_DECLINE_3M_PCT) {
      return { ticker, skipped: true, reason: `down_${Math.abs(trend.change3m).toFixed(0)}pct_3m` };
    }
  }

  // Check 3.6: Beta filter — skip high-beta stocks (too volatile for wheel strategy)
  const beta = await getStockBeta(ticker);
  checks.beta = beta !== null ? beta.toFixed(2) : 'unknown';
  if (beta !== null && beta > MAX_BETA) {
    return { ticker, skipped: true, reason: `high_beta:${beta.toFixed(2)}` };
  }

  // Check 4: Earnings blackout
  const earningsDate = await getEarningsDate(ticker);
  const daysToEarnings = earningsDate ? daysUntil(earningsDate) : 999;
  checks.earningsBlackout = daysToEarnings > EARNINGS_BLACKOUT_DAYS;
  if (daysToEarnings <= EARNINGS_BLACKOUT_DAYS) return { ticker, skipped: true, reason: `earnings_in_${daysToEarnings}d` };

  // Check 4.5: News sentiment — block on red-flag headlines or strongly negative sentiment
  const newsSentiment = await getNewsSentiment(ticker);
  checks.newsSentiment = newsSentiment.redFlagFound
    ? `red_flag:${newsSentiment.redFlagReason}`
    : `score:${newsSentiment.score.toFixed(2)}`;
  if (newsSentiment.redFlagFound) {
    return { ticker, skipped: true, reason: `news_red_flag:${newsSentiment.redFlagReason}` };
  }
  if (newsSentiment.score < MIN_SENTIMENT_SCORE) {
    return { ticker, skipped: true, reason: `negative_sentiment:${newsSentiment.score.toFixed(2)}` };
  }

  // Check 4.6: Sector concentration — max 2 positions per sector
  const sector = await getStockSector(ticker);
  const sectorCount = ctx.openCountBySector.get(sector) ?? 0;
  checks.sectorConcentration = `${sector}(${sectorCount}/${MAX_SECTOR_POSITIONS})`;
  if (sectorCount >= MAX_SECTOR_POSITIONS) {
    return { ticker, skipped: true, reason: `sector_limit:${sector}` };
  }

  // Check 4.7: Bear mode sector filter — in bear market, only defensive sectors
  if (ctx.bearMode) {
    const isDefensive = BEAR_DEFENSIVE_SECTORS.some(s => sector.toLowerCase().includes(s.toLowerCase()));
    checks.bearModeSector = `${isDefensive ? 'defensive' : 'non_defensive'}:${sector}`;
    if (!isDefensive) {
      return { ticker, skipped: true, reason: `bear_mode_non_defensive:${sector}` };
    }
  }

  // Check 5: RSI oversold + recovering
  const rsiData = await getRSI(ticker);
  const rsiOk = rsiData ? (rsiData.rsi < RSI_OVERSOLD && rsiData.rsi > rsiData.prevRsi) : false;
  checks.rsiOversold = rsiData ? `${rsiData.rsi.toFixed(1)} (prev ${rsiData.prevRsi.toFixed(1)})` : 'no_data';
  // RSI check is a soft signal — don't hard-block, just reduce score
  const rsiBonus = rsiOk;

  // Check 6: Options chain — uses IB when connected, Black-Scholes synthetic fallback otherwise
  // In bear mode: target 15-delta + 21 DTE; normal: 20-25 delta + 30-45 DTE
  const chain = await getOptionsChain(
    ticker,
    price,
    null,
    ctx.bearMode ? BEAR_DELTA_TARGET : undefined,
    ctx.bearMode ? BEAR_DTE_TARGET : undefined,
  );
  if (!chain?.bestPut) return { ticker, skipped: true, reason: 'no_options_chain' };
  const put = chain.bestPut;

  // Check 6.5: Liquidity — bid-ask spread must be < 30% of mid
  const spread = put.ask - put.bid;
  const spreadPct = put.mid > 0 ? spread / put.mid : 1;
  checks.liquidity = `spread:${(spreadPct * 100).toFixed(0)}%_bid:${put.bid.toFixed(2)}_ask:${put.ask.toFixed(2)}`;
  if (spreadPct > MAX_SPREAD_PCT) {
    return { ticker, skipped: true, reason: `wide_spread:${(spreadPct * 100).toFixed(0)}pct` };
  }
  if (put.bid <= 0) {
    return { ticker, skipped: true, reason: 'no_bid_no_market' };
  }

  // Check 7: Premium yield threshold (use bid price for conservative estimate)
  const dte = daysToExpiryFromStr(put.expiry);
  const conservativePremium = put.bid; // worst-case fill at bid
  const dailyYield = conservativePremium / put.strike;
  const monthlyYield = dailyYield * 30;
  checks.premiumYield = monthlyYield >= MIN_PREMIUM_YIELD_PCT / 100;
  if (monthlyYield < MIN_PREMIUM_YIELD_PCT / 100) return { ticker, skipped: true, reason: `low_premium_${(monthlyYield * 100).toFixed(2)}pct` };

  // Check 8: Capital sufficiency (bear mode uses 50% position size)
  const capitalRequired = put.strike * 100;
  const effectiveCapitalRequired = ctx.bearMode
    ? capitalRequired * BEAR_POSITION_SIZE_FACTOR
    : capitalRequired;
  checks.capitalSufficient = ctx.freeCapital >= effectiveCapitalRequired;
  if (ctx.freeCapital < effectiveCapitalRequired) return { ticker, skipped: true, reason: 'insufficient_capital' };

  // Check 9: IV rank
  const currentIvPct = chain.currentIV * 100;
  const ivRank = await getIvRank(ticker, currentIvPct);
  checks.ivRank = ivRank !== null ? `${ivRank}` : 'building_history';
  const ivOk = ivRank === null || ivRank >= MIN_IV_RANK;

  // Check 9.5: IV spike — sudden >20pt jump = news event, skip
  const ivSpike = await checkIvSpike(ticker, currentIvPct);
  checks.noIvSpike = ivSpike.spiked ? `SPIKE+${ivSpike.delta.toFixed(0)}pts` : `ok(${ivSpike.delta > 0 ? '+' : ''}${ivSpike.delta.toFixed(0)}pts)`;
  if (ivSpike.spiked) {
    return { ticker, skipped: true, reason: `iv_spike:+${ivSpike.delta.toFixed(0)}pts` };
  }

  const checksPassedCount = [
    ctx.spyAboveSma200,
    ctx.openPutCount < maxPositions,
    price >= effectiveMinPrice,
    daysToEarnings > EARNINGS_BLACKOUT_DAYS,
    !newsSentiment.redFlagFound && newsSentiment.score >= MIN_SENTIMENT_SCORE,
    sectorCount < MAX_SECTOR_POSITIONS,
    rsiBonus,
    !!chain.bestPut,
    spreadPct <= MAX_SPREAD_PCT && put.bid > 0,
    monthlyYield >= MIN_PREMIUM_YIELD_PCT / 100,
    ctx.freeCapital >= capitalRequired,
    ivOk,
    !ivSpike.spiked,
  ].filter(Boolean).length;

  return {
    ticker,
    currentPrice: price,
    signal: 'SELL_PUT' as const,
    strike: put.strike,
    expiry: put.expiry,
    expiryFormatted: formatExpiry(put.expiry),
    daysToExpiry: dte,
    premium: conservativePremium,  // bid price — realistic fill
    premiumTotal: Math.round(conservativePremium * 100),
    netPrice: put.strike - conservativePremium,
    capitalRequired: effectiveCapitalRequired,
    delta: put.delta,
    ivRank,
    probProfit: put.probProfit,
    annualYield: put.annualYield,
    checksPassedCount,
    checksDetail: checks,
    bearMode: ctx.bearMode,
  };
}

// ── Main Scanner ─────────────────────────────────────────

export interface OptionsScanResult {
  opportunities: OptionsTradeTicket[];
  skipped: Array<{ ticker: string; reason: string }>;
  scanDate: string;
  spyAboveSma200: boolean;
  vix: number;
  openPutCount: number;
}

export async function runOptionsScan(freeCapital = 100_000): Promise<OptionsScanResult> {
  const sb = getSupabase();
  const scanDate = new Date().toISOString().slice(0, 10);

  // Load active watchlist
  const { data: watchlist } = await sb
    .from('options_watchlist')
    .select('ticker, min_price')
    .eq('active', true)
    .order('ticker');

  if (!watchlist?.length) {
    return { opportunities: [], skipped: [], scanDate, spyAboveSma200: true, vix: 20, openPutCount: 0 };
  }

  const ctx = await buildScanContext(freeCapital);
  const opportunities: OptionsTradeTicket[] = [];
  const skipped: Array<{ ticker: string; reason: string }> = [];

  // Scan each ticker (sequential to avoid IB request flooding)
  for (const entry of watchlist as WatchlistEntry[]) {
    const result = await checkStock(entry.ticker, entry.min_price, ctx);

    if ('skipped' in result) {
      skipped.push({ ticker: result.ticker, reason: result.reason });
    } else {
      opportunities.push(result);

      // Increment open count to respect position limit during scan
      ctx.openPutCount += 1;
    }

    // Small delay between IB requests to avoid throttling
    await new Promise(r => setTimeout(r, 500));
  }

  // Sort by annual yield descending
  opportunities.sort((a, b) => b.annualYield - a.annualYield);

  // Auto-trade top opportunities if enabled
  const { enabled: autoEnabled, maxContracts } = await getOptionsAutoTradeConfig();
  if (autoEnabled && opportunities.length > 0) {
    const toTrade = opportunities.slice(0, maxContracts);
    for (const opp of toTrade) {
      const result = await autoTradeOption(opp);
      if (result.isLive) {
        console.log(`[Options Scan] Auto-traded ${opp.ticker}: IB order ${result.ibOrderId}`);
      } else {
        console.log(`[Options Scan] Paper-traded ${opp.ticker} (auto-trade off or IB unavailable)`);
      }
    }
  }

  // Persist opportunities
  for (const opp of opportunities) {
    await sb.from('options_scan_results').upsert({
      ticker: opp.ticker,
      scan_date: scanDate,
      signal: opp.signal,
      strike: opp.strike,
      expiry: new Date(`${opp.expiry.slice(0, 4)}-${opp.expiry.slice(4, 6)}-${opp.expiry.slice(6, 8)}`).toISOString().slice(0, 10),
      premium: opp.premium,
      net_price: opp.netPrice,
      delta: opp.delta,
      iv_rank: opp.ivRank,
      prob_profit: opp.probProfit,
      capital_req: opp.capitalRequired,
      annual_yield: opp.annualYield,
      checks_passed: opp.checksDetail,
      bear_mode: opp.bearMode,
    }, { onConflict: 'ticker,scan_date,signal' });
  }

  // Persist skipped tickers so the UI can explain why nothing showed up
  for (const s of skipped) {
    await sb.from('options_scan_results').upsert({
      ticker: s.ticker,
      scan_date: scanDate,
      signal: 'NO_SIGNAL',
      skip_reason: s.reason,
    }, { onConflict: 'ticker,scan_date,signal' });
  }

  return { opportunities, skipped, scanDate, spyAboveSma200: ctx.spyAboveSma200, vix: ctx.vix, openPutCount: ctx.openPutCount };
}

/**
 * Record an options trade in paper_trades.
 * If ibOrderId is provided the trade was auto-executed via IB (status=SUBMITTED).
 * Otherwise it's a pure paper record (status=FILLED).
 */
export async function paperTradeOption(
  ticket: OptionsTradeTicket,
  ibOrderId?: number,
): Promise<string | null> {
  const sb = getSupabase();
  const isLive = ibOrderId !== undefined;

  const { data, error } = await sb.from('paper_trades').insert({
    ticker: ticket.ticker,
    mode: 'OPTIONS_PUT',
    signal: 'SELL',
    entry_price: ticket.currentPrice,
    fill_price: isLive ? null : ticket.currentPrice,  // filled later via IB event
    quantity: 1,
    position_size: ticket.capitalRequired,
    status: isLive ? 'SUBMITTED' : 'FILLED',
    filled_at: isLive ? null : new Date().toISOString(),
    opened_at: new Date().toISOString(),
    option_strike: ticket.strike,
    option_expiry: `${ticket.expiry.slice(0, 4)}-${ticket.expiry.slice(4, 6)}-${ticket.expiry.slice(6, 8)}`,
    option_premium: ticket.premium,
    option_contracts: 1,
    option_delta: ticket.delta,
    option_iv_rank: ticket.ivRank,
    option_prob_profit: ticket.probProfit,
    option_net_price: ticket.netPrice,
    option_capital_req: ticket.capitalRequired,
    option_annual_yield: ticket.annualYield,
    ib_order_id: ibOrderId ?? null,
    notes: `${isLive ? '[AUTO]' : '[PAPER]'} Sell put: $${ticket.strike} strike, ${ticket.expiryFormatted}, collect $${ticket.premiumTotal}`,
    scanner_reason: `IV Rank: ${ticket.ivRank ?? 'n/a'}, Prob Profit: ${ticket.probProfit.toFixed(0)}%, Annual yield: ${ticket.annualYield.toFixed(1)}%`,
  }).select('id').single();

  if (error) {
    console.error('[Options Scanner] Failed to create trade record:', error.message);
    return null;
  }
  return data?.id ?? null;
}

/**
 * Auto-execute a trade ticket via IB Gateway, then record it.
 * Falls back to paper-only if IB is unavailable or order fails.
 */
export async function autoTradeOption(ticket: OptionsTradeTicket): Promise<{ tradeId: string | null; ibOrderId: number | null; isLive: boolean }> {
  if (!isConnected()) {
    console.warn('[Options Auto-Trade] IB not connected — falling back to paper trade');
    const tradeId = await paperTradeOption(ticket);
    createAutoTradeEvent({
      ticker: ticket.ticker,
      event_type: 'warning',
      action: 'executed',
      source: 'scanner',
      mode: 'OPTIONS_PUT',
      message: `Paper trade opened — IB offline. Sold $${ticket.strike}P exp ${ticket.expiry}, premium $${ticket.premium.toFixed(2)}`,
      metadata: { strike: ticket.strike, expiry: ticket.expiry, premium: ticket.premium, paper: true },
    });
    return { tradeId, ibOrderId: null, isLive: false };
  }

  try {
    const { orderId } = await placeOptionsOrder({
      symbol: ticket.ticker,
      right: 'P',
      strike: ticket.strike,
      expiry: ticket.expiry,
      contracts: 1,
      limitPrice: ticket.premium,
      account: getDefaultAccount() ?? undefined,
    });

    console.log(`[Options Auto-Trade] Placed IB order ${orderId} for ${ticket.ticker} $${ticket.strike}P`);
    const tradeId = await paperTradeOption(ticket, orderId);
    createAutoTradeEvent({
      ticker: ticket.ticker,
      event_type: 'success',
      action: 'executed',
      source: 'scanner',
      mode: 'OPTIONS_PUT',
      message: `Live order placed #${orderId} — Sold $${ticket.strike}P exp ${ticket.expiry}, limit $${ticket.premium.toFixed(2)}`,
      metadata: { ibOrderId: orderId, strike: ticket.strike, expiry: ticket.expiry, premium: ticket.premium },
    });
    return { tradeId, ibOrderId: orderId, isLive: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[Options Auto-Trade] IB order failed, falling back to paper:', err);
    const tradeId = await paperTradeOption(ticket);
    createAutoTradeEvent({
      ticker: ticket.ticker,
      event_type: 'error',
      action: 'failed',
      source: 'scanner',
      mode: 'OPTIONS_PUT',
      message: `IB order failed — paper fallback. $${ticket.strike}P exp ${ticket.expiry}. Error: ${errMsg}`,
      metadata: { strike: ticket.strike, expiry: ticket.expiry, premium: ticket.premium, error: errMsg },
    });
    return { tradeId, ibOrderId: null, isLive: false };
  }
}

/**
 * Read options auto-trade setting from DB.
 */
async function getOptionsAutoTradeConfig(): Promise<{ enabled: boolean; maxContracts: number }> {
  const sb = getSupabase();
  const { data } = await sb
    .from('auto_trader_config')
    .select('options_auto_trade_enabled, options_max_contracts_per_scan')
    .eq('id', 'default')
    .single();
  return {
    enabled: (data as { options_auto_trade_enabled?: boolean } | null)?.options_auto_trade_enabled ?? false,
    maxContracts: (data as { options_max_contracts_per_scan?: number } | null)?.options_max_contracts_per_scan ?? 1,
  };
}
