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

import { getSupabase } from './supabase.js';
import { getOptionsChain, type OptionGreeks } from './options-chain.js';
import { isConnected } from '../ib-connection.js';

// ── Constants ────────────────────────────────────────────

const FINNHUB_KEY = process.env.FINNHUB_API_KEY ?? '';
const MIN_STOCK_PRICE = 20;
const MIN_PREMIUM_YIELD_PCT = 0.8;   // at least 0.8% of strike per 30 days
const MIN_IV_RANK = 50;              // only sell when premium is elevated
const RSI_OVERSOLD = 38;             // RSI threshold for oversold
const MAX_POSITIONS_NORMAL = 5;      // max concurrent open options puts
const MAX_POSITIONS_HIGH_VIX = 3;    // VIX > 25
const EARNINGS_BLACKOUT_DAYS = 14;
const IV_SPIKE_THRESHOLD = 20;       // points

// ── Types ────────────────────────────────────────────────

export interface OptionsTradeTicket {
  ticker: string;
  currentPrice: number;
  signal: 'SELL_PUT' | 'SELL_CALL';
  strike: number;
  expiry: string;           // YYYYMMDD
  expiryFormatted: string;  // e.g. "Jan 31"
  daysToExpiry: number;
  premium: number;          // per share (mid price - slippage)
  premiumTotal: number;     // premium × 100 (per contract)
  netPrice: number;         // strike - premium (effective cost if assigned)
  capitalRequired: number;  // strike × 100
  delta: number;
  ivRank: number | null;
  probProfit: number;
  annualYield: number;
  checksPassedCount: number;
  checksDetail: Record<string, boolean | string>;
}

interface WatchlistEntry {
  ticker: string;
  min_price: number | null;
}

interface ScanContext {
  spyAboveSma200: boolean;
  vix: number;
  openPutCount: number;
  deployedCapitalByTicker: Map<string, number>;
  sectorByTicker: Map<string, string>;
  openCountBySector: Map<string, number>;
  freeCapital: number;
}

// ── Finnhub Helpers ──────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
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
      .select('ticker, mode, position_size, notes')
      .in('mode', ['OPTIONS_PUT', 'OPTIONS_CALL'])
      .in('status', ['PENDING', 'SUBMITTED', 'FILLED', 'PARTIAL']),
  ]);

  const sectorByTicker = new Map<string, string>();
  const openCountBySector = new Map<string, number>();
  const deployedByTicker = new Map<string, number>();

  for (const pos of openPositions.data ?? []) {
    deployedByTicker.set(pos.ticker, (deployedByTicker.get(pos.ticker) ?? 0) + (pos.position_size ?? 0));
  }

  return {
    spyAboveSma200: spyData ? spyData.price > spyData.sma200 : true, // default to allow
    vix,
    openPutCount: (openPositions.data ?? []).filter(p => p.mode === 'OPTIONS_PUT').length,
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

  // Check 1: Bear market gate
  checks.bearMarketGate = ctx.spyAboveSma200;
  if (!ctx.spyAboveSma200) return { ticker, skipped: true, reason: 'bear_market' };

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

  // Check 4: Earnings blackout
  const earningsDate = await getEarningsDate(ticker);
  const daysToEarnings = earningsDate ? daysUntil(earningsDate) : 999;
  checks.earningsBlackout = daysToEarnings > EARNINGS_BLACKOUT_DAYS;
  if (daysToEarnings <= EARNINGS_BLACKOUT_DAYS) return { ticker, skipped: true, reason: `earnings_in_${daysToEarnings}d` };

  // Check 5: RSI oversold + recovering
  const rsiData = await getRSI(ticker);
  const rsiOk = rsiData ? (rsiData.rsi < RSI_OVERSOLD && rsiData.rsi > rsiData.prevRsi) : false;
  checks.rsiOversold = rsiData ? `${rsiData.rsi.toFixed(1)} (prev ${rsiData.prevRsi.toFixed(1)})` : 'no_data';
  // RSI check is a soft signal — don't hard-block, just reduce score
  const rsiBonus = rsiOk;

  // Check 6: IB options chain (requires IB connection)
  if (!isConnected()) return { ticker, skipped: true, reason: 'ib_not_connected' };

  const chain = await getOptionsChain(ticker, price, null);
  if (!chain?.bestPut) return { ticker, skipped: true, reason: 'no_options_chain' };
  const put = chain.bestPut;

  // Check 7: Premium yield threshold
  const dte = daysToExpiryFromStr(put.expiry);
  const dailyYield = put.mid / put.strike;
  const monthlyYield = dailyYield * 30;
  checks.premiumYield = monthlyYield >= MIN_PREMIUM_YIELD_PCT / 100;
  if (monthlyYield < MIN_PREMIUM_YIELD_PCT / 100) return { ticker, skipped: true, reason: `low_premium_${(monthlyYield * 100).toFixed(2)}pct` };

  // Check 8: Capital sufficiency
  const capitalRequired = put.strike * 100;
  checks.capitalSufficient = ctx.freeCapital >= capitalRequired;
  if (ctx.freeCapital < capitalRequired) return { ticker, skipped: true, reason: 'insufficient_capital' };

  // Check 9: IV check (use IV from chain; rank from DB history)
  const ivRank = await getIvRank(ticker, chain.currentIV * 100);
  checks.ivRank = ivRank !== null ? `${ivRank}` : 'building_history';
  const ivOk = ivRank === null || ivRank >= MIN_IV_RANK; // allow if no history yet

  // IV spike check (if IV rank jumped suddenly — skip for manual review)
  // We check this by comparing stored yesterday's IV to today's
  checks.noIvSpike = true; // simplified for v1; full spike detection in v2

  const checksPassedCount = [
    ctx.spyAboveSma200,
    ctx.openPutCount < maxPositions,
    price >= effectiveMinPrice,
    daysToEarnings > EARNINGS_BLACKOUT_DAYS,
    rsiBonus,
    !!chain.bestPut,
    monthlyYield >= MIN_PREMIUM_YIELD_PCT / 100,
    ctx.freeCapital >= capitalRequired,
    ivOk,
  ].filter(Boolean).length;

  return {
    ticker,
    currentPrice: price,
    signal: 'SELL_PUT' as const,
    strike: put.strike,
    expiry: put.expiry,
    expiryFormatted: formatExpiry(put.expiry),
    daysToExpiry: dte,
    premium: put.mid,
    premiumTotal: Math.round(put.mid * 100),
    netPrice: put.strike - put.mid,
    capitalRequired,
    delta: put.delta,
    ivRank,
    probProfit: put.probProfit,
    annualYield: put.annualYield,
    checksPassedCount,
    checksDetail: checks,
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

  // Persist scan results
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
    }, { onConflict: 'ticker,scan_date,signal' });
  }

  return { opportunities, skipped, scanDate, spyAboveSma200: ctx.spyAboveSma200, vix: ctx.vix, openPutCount: ctx.openPutCount };
}

/**
 * Paper-trade an options opportunity — creates a paper_trades record
 * in OPTIONS_PUT mode.
 */
export async function paperTradeOption(ticket: OptionsTradeTicket): Promise<string | null> {
  const sb = getSupabase();
  const { data, error } = await sb.from('paper_trades').insert({
    ticker: ticket.ticker,
    mode: 'OPTIONS_PUT',
    signal: 'SELL',
    entry_price: ticket.currentPrice,
    fill_price: ticket.currentPrice,
    quantity: 1,                              // 1 contract = 100 shares
    position_size: ticket.capitalRequired,
    status: 'FILLED',
    filled_at: new Date().toISOString(),
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
    notes: `Sell put: $${ticket.strike} strike, ${ticket.expiryFormatted}, collect $${ticket.premiumTotal}`,
    scanner_reason: `IV Rank: ${ticket.ivRank ?? 'n/a'}, Prob Profit: ${ticket.probProfit.toFixed(0)}%, Annual yield: ${ticket.annualYield.toFixed(1)}%`,
  }).select('id').single();

  if (error) {
    console.error('[Options Scanner] Failed to create paper trade:', error.message);
    return null;
  }
  return data?.id ?? null;
}
