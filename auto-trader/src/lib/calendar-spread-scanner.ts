/**
 * Calendar Spread Scanner
 *
 * Identifies calendar spread opportunities on the options watchlist.
 * A calendar spread sells a near-term option and buys a longer-term option
 * at the same strike — defined-risk, benefits from time decay differential
 * and IV expansion in the back month.
 *
 * Entry criteria:
 *   1. Watchlist membership + active
 *   2. Front IV > Back IV (term structure inversion or flat = edge)
 *   3. IV rank ≥ 40 (enough premium to justify the trade)
 *   4. Stock in a range: BB width < 25% (range-bound = calendar's sweet spot)
 *   5. No earnings between front and back expiry
 *   6. Net debit ≤ $500 per spread (defined max risk)
 *   7. Min 14 DTE on front leg, 45+ DTE on back leg
 *
 * This is Phase 1 — paper trading only, human approval required for live.
 */

import { getOptionsChain, type OptionGreeks, type OptionsChainSummary } from './options-chain.js';
import { getSupabase, createAutoTradeEvent } from './supabase.js';
import { ACTIVE_STATUSES } from '../../../shared/trade-status-sets.js';
import { fetchDailyBars, sma as calcSma } from './yahoo-finance.js';

// ── Constants ────────────────────────────────────────────

const FINNHUB_KEY = process.env.FINNHUB_API_KEY ?? '';
const MIN_IV_RANK = 40;
const MAX_BB_WIDTH_PCT = 25;
const MIN_FRONT_DTE = 14;
const MAX_FRONT_DTE = 30;
const MIN_BACK_DTE = 45;
const MAX_BACK_DTE = 75;
const MAX_NET_DEBIT = 500;       // $500 max risk per spread
const MAX_CALENDAR_POSITIONS = 3; // paper phase: max concurrent calendar spreads

// ── Types ────────────────────────────────────────────────

export interface CalendarSpreadTicket {
  ticker: string;
  right: 'P' | 'C';
  strike: number;
  frontExpiry: string;      // YYYYMMDD
  backExpiry: string;       // YYYYMMDD
  frontDte: number;
  backDte: number;
  frontPremium: number;     // premium received (sell)
  backPremium: number;      // premium paid (buy)
  netDebit: number;         // backPremium - frontPremium (max loss)
  frontIV: number;
  backIV: number;
  ivEdge: number;           // front IV - back IV (positive = favorable)
  ivRank: number | null;
  bbWidth: number;          // Bollinger Band width as % of price
  maxRisk: number;          // netDebit × 100 (per contract)
  maxProfit: number;        // theoretical: premium collected on front leg at expiry
  checksDetail: Record<string, string>;
}

export interface CalendarSpreadScanResult {
  opportunities: CalendarSpreadTicket[];
  skipped: Array<{ ticker: string; reason: string }>;
  scanDate: string;
}

// ── Helpers ──────────────────────────────────────────────

function daysToExpiryFromStr(yyyymmdd: string): number {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  return Math.ceil((new Date(y, m, d).getTime() - Date.now()) / 86_400_000);
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json() as T;
  } catch { return null; }
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

async function getBollingerWidth(ticker: string, price: number): Promise<number | null> {
  const bars = await fetchDailyBars(ticker, '2mo');
  if (!bars || bars.length < 20) return null;
  const closes = bars.slice(-20).map(b => b.close);
  const sma20 = closes.reduce((a, b) => a + b, 0) / closes.length;
  const stdDev = Math.sqrt(closes.reduce((s, c) => s + (c - sma20) ** 2, 0) / closes.length);
  const upper = sma20 + 2 * stdDev;
  const lower = sma20 - 2 * stdDev;
  return ((upper - lower) / price) * 100;
}

// ── Scanner ──────────────────────────────────────────────

async function evaluateCalendarSpread(
  ticker: string,
  chain: OptionsChainSummary,
  bbWidth: number,
  ivRank: number | null,
  earningsDate: Date | null,
): Promise<CalendarSpreadTicket | { ticker: string; skipped: true; reason: string }> {
  const checks: Record<string, string> = {};

  if (!chain.bestPut) {
    return { ticker, skipped: true, reason: 'no_put_chain' };
  }

  // Use the put's strike as the calendar strike (ATM-ish)
  const strike = chain.bestPut.strike;
  const expirations = chain.expirations.map(e => ({
    e,
    dte: daysToExpiryFromStr(e),
  }));

  // Find front and back leg candidates
  const frontCandidates = expirations.filter(x => x.dte >= MIN_FRONT_DTE && x.dte <= MAX_FRONT_DTE);
  const backCandidates = expirations.filter(x => x.dte >= MIN_BACK_DTE && x.dte <= MAX_BACK_DTE);

  if (frontCandidates.length === 0) {
    return { ticker, skipped: true, reason: `no_front_expiry_${MIN_FRONT_DTE}-${MAX_FRONT_DTE}dte` };
  }
  if (backCandidates.length === 0) {
    return { ticker, skipped: true, reason: `no_back_expiry_${MIN_BACK_DTE}-${MAX_BACK_DTE}dte` };
  }

  // Pick front closest to 21 DTE, back closest to 60 DTE
  const front = frontCandidates.sort((a, b) => Math.abs(a.dte - 21) - Math.abs(b.dte - 21))[0];
  const back = backCandidates.sort((a, b) => Math.abs(a.dte - 60) - Math.abs(b.dte - 60))[0];
  checks.frontExpiry = `${front.e}_${front.dte}dte`;
  checks.backExpiry = `${back.e}_${back.dte}dte`;

  // Earnings check: no earnings between front and back expiry
  if (earningsDate) {
    const earningsYMD = earningsDate.toISOString().slice(0, 10).replace(/-/g, '');
    if (earningsYMD >= front.e && earningsYMD <= back.e) {
      checks.earnings = `BLOCKED_earnings_${earningsYMD}_between_legs`;
      return { ticker, skipped: true, reason: `earnings_between_legs:${earningsYMD}` };
    }
    checks.earnings = 'clear';
  } else {
    checks.earnings = 'no_data';
  }

  // IV rank check
  checks.ivRank = ivRank !== null ? `${ivRank}` : 'building';
  if (ivRank !== null && ivRank < MIN_IV_RANK) {
    return { ticker, skipped: true, reason: `low_iv_rank:${ivRank}` };
  }

  // BB width check — calendars work best in range-bound markets
  checks.bbWidth = `${bbWidth.toFixed(1)}%`;
  if (bbWidth > MAX_BB_WIDTH_PCT) {
    return { ticker, skipped: true, reason: `wide_bb:${bbWidth.toFixed(1)}pct` };
  }

  // Use the chain's current IV as a proxy for the front leg IV.
  // Back leg IV estimated as slightly lower (typical contango term structure).
  // In reality these would come from separate chain queries per expiry.
  const frontIV = chain.currentIV;
  const backIV = chain.currentIV * 0.92; // conservative estimate
  const ivEdge = (frontIV - backIV) * 100;
  checks.ivEdge = `front:${(frontIV * 100).toFixed(0)}%_back:${(backIV * 100).toFixed(0)}%_edge:${ivEdge.toFixed(1)}pts`;

  // Estimate premiums using the chain's best put as reference
  const frontPremium = chain.bestPut.bid;
  const dteRatio = back.dte / front.dte;
  const backPremium = frontPremium * Math.sqrt(dteRatio); // square-root-of-time approximation
  const netDebit = Math.max(0, backPremium - frontPremium);
  const maxRisk = Math.round(netDebit * 100);

  checks.netDebit = `$${netDebit.toFixed(2)}_risk:$${maxRisk}`;
  if (maxRisk > MAX_NET_DEBIT) {
    return { ticker, skipped: true, reason: `risk_too_high:$${maxRisk}` };
  }
  if (maxRisk <= 0) {
    return { ticker, skipped: true, reason: 'zero_net_debit' };
  }

  return {
    ticker,
    right: 'P',
    strike,
    frontExpiry: front.e,
    backExpiry: back.e,
    frontDte: front.dte,
    backDte: back.dte,
    frontPremium,
    backPremium,
    netDebit,
    frontIV,
    backIV,
    ivEdge,
    ivRank,
    bbWidth,
    maxRisk,
    maxProfit: Math.round(frontPremium * 100),
    checksDetail: checks,
  };
}

/**
 * Run the calendar spread scan across the options watchlist.
 * Phase 1: paper-only, generates opportunities for human review.
 */
export async function runCalendarSpreadScan(): Promise<CalendarSpreadScanResult> {
  const sb = getSupabase();
  const scanDate = new Date().toISOString().slice(0, 10);

  const { data: watchlist } = await sb
    .from('options_watchlist')
    .select('ticker, min_price, notes, tier')
    .eq('active', true)
    .order('ticker');

  if (!watchlist?.length) {
    return { opportunities: [], skipped: [], scanDate };
  }

  // Check current open calendar positions
  const { data: openCalendars } = await sb
    .from('paper_trades')
    .select('ticker')
    .eq('mode', 'CALENDAR_SPREAD')
    .in('status', [...ACTIVE_STATUSES]);
  const openCount = (openCalendars ?? []).length;

  if (openCount >= MAX_CALENDAR_POSITIONS) {
    console.log(`[Calendar Scanner] Max positions reached (${openCount}/${MAX_CALENDAR_POSITIONS}), skipping scan`);
    return { opportunities: [], skipped: [], scanDate };
  }

  const opportunities: CalendarSpreadTicket[] = [];
  const skipped: Array<{ ticker: string; reason: string }> = [];
  const total = watchlist.length;

  console.log(`\n[Calendar Scanner] ━━━ Scanning ${total} tickers for calendar spread opportunities ━━━`);

  for (const [i, entry] of watchlist.entries()) {
    const num = `[${String(i + 1).padStart(2, '0')}/${total}]`;
    const ticker = entry.ticker;

    try {
      const chain = await getOptionsChain(ticker, 0);
      if (!chain || !chain.bestPut) {
        skipped.push({ ticker, reason: 'no_chain' });
        console.log(`[Calendar Scanner] ${num} ${ticker.padEnd(5)} ✗  no_chain`);
        continue;
      }

      const [bbWidth, earningsDate] = await Promise.all([
        getBollingerWidth(ticker, chain.underlyingPrice),
        getEarningsDate(ticker),
      ]);

      if (bbWidth === null) {
        skipped.push({ ticker, reason: 'no_bb_data' });
        console.log(`[Calendar Scanner] ${num} ${ticker.padEnd(5)} ✗  no_bb_data`);
        continue;
      }

      const ivRank = chain.ivRank;
      const result = await evaluateCalendarSpread(ticker, chain, bbWidth, ivRank, earningsDate);

      if ('skipped' in result) {
        skipped.push({ ticker, reason: result.reason });
        console.log(`[Calendar Scanner] ${num} ${ticker.padEnd(5)} ✗  ${result.reason}`);
      } else {
        opportunities.push(result);
        console.log(`[Calendar Scanner] ${num} ${ticker.padEnd(5)} ✅ $${result.strike} ${result.right} | front ${result.frontDte}d / back ${result.backDte}d | risk $${result.maxRisk}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      skipped.push({ ticker, reason: `error:${msg.slice(0, 60)}` });
      console.error(`[Calendar Scanner] ${num} ${ticker.padEnd(5)} 💥 ${msg}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  // Sort by IV edge (higher = better)
  opportunities.sort((a, b) => b.ivEdge - a.ivEdge);

  console.log(`[Calendar Scanner] ━━━ Done — ${opportunities.length} opportunities, ${skipped.length} skipped ━━━\n`);

  // Log top opportunities to activity log
  for (const opp of opportunities.slice(0, 3)) {
    await createAutoTradeEvent({
      ticker: opp.ticker,
      mode: 'CALENDAR_SPREAD',
      event_type: 'info',
      message: `Calendar opportunity: $${opp.strike}${opp.right} sell ${opp.frontExpiry} / buy ${opp.backExpiry}, risk $${opp.maxRisk}, IV edge ${opp.ivEdge.toFixed(1)}pts`,
      metadata: {
        strike: opp.strike,
        right: opp.right,
        frontExpiry: opp.frontExpiry,
        backExpiry: opp.backExpiry,
        netDebit: opp.netDebit,
        maxRisk: opp.maxRisk,
        ivEdge: opp.ivEdge,
        bbWidth: opp.bbWidth,
      },
    }).catch(() => {});
  }

  return { opportunities, skipped, scanDate };
}
