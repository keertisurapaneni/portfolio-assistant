/**
 * Credit Spread Scanner
 *
 * Scans the options watchlist for vertical credit spread opportunities.
 * Based on Tony Zang / OptionsPlay framework:
 *   - Bull put spread (bullish): sell ATM put + buy 25-delta put
 *   - Bear call spread (bearish): sell ATM call + buy 25-delta call
 *   - 45 DTE target
 *   - Collect ≥33% of vertical width (optimal: 40%+)
 *   - Max 2% of account per trade
 *
 * Entry timing: trend following with pullback entries.
 * Exit rules: 50% profit take, 100% stop loss, 21 DTE time exit.
 * Entry gates: trend/pullback, earnings blackout, IV rank ≥ 30 (avoid crushed-IV).
 */

import { findSpreadStrikes, getOptionGreeksForContract, type SpreadStrikeResult } from './options-chain.js';
import { getSupabase, createAutoTradeEvent } from './supabase.js';
import { recordTradeClose } from './trade-closer.js';
import { ACTIVE_STATUSES } from '../../../shared/trade-status-sets.js';
import { fetchDailyBars, fetchQuote, sma as calcSma } from './yahoo-finance.js';
import { isConnected, placeVerticalSpreadOrder, getDefaultAccount, cancelOrder } from '../ib-connection.js';
import { finnhubFetch, FINNHUB_KEY } from './finnhub.js';

// ── Constants ────────────────────────────────────────────
const MIN_CREDIT_PCT = 0.33;           // collect at least 33% of width
const PREFERRED_CREDIT_PCT = 0.40;     // Tony's sweet spot: 40%+
const MAX_RISK_PCT = 0.02;             // max 2% of account per trade
const MAX_SPREAD_POSITIONS = 8;        // max concurrent credit spreads
const TARGET_DTE = 45;
const MIN_STOCK_PRICE = 20;
const MAX_PORTFOLIO_SPREAD_RISK = 0.30; // circuit breaker: max 30% of account in spread risk
const PULLBACK_THRESHOLD_PCT = 3;      // stock pulled back ≥3% from recent high = entry signal
const TREND_SMA_DAYS = 50;             // stock must be above/below 50-SMA for trend confirmation
const MIN_IV_RANK = 30;                // minimum IV rank — don't sell spreads in crushed-IV environments
/** Unfilled close orders older than this are cancelled + cleared so management can resume. */
const STALE_CLOSE_ORDER_MS = 4 * 60 * 60 * 1000; // 4 hours
/** Within this many DTE, unfilled closes are always treated as stale (no grace wait). */
const STALE_CLOSE_NEAR_EXPIRY_DTE = 7;

// ── Types ────────────────────────────────────────────────

export interface CreditSpreadTicket {
  ticker: string;
  direction: 'BULL_PUT' | 'BEAR_CALL';
  sellStrike: number;
  buyStrike: number;
  expiry: string;           // YYYYMMDD
  dte: number;
  width: number;
  netCredit: number;        // per share
  creditPct: number;
  maxGain: number;          // netCredit × 100 × contracts
  maxLoss: number;          // (width - netCredit) × 100 × contracts
  contracts: number;
  sellDelta: number;
  buyDelta: number;
  currentPrice: number;
  pullbackPct: number;
  aboveSma50: boolean;
  checksDetail: Record<string, string>;
}

export interface CreditSpreadScanResult {
  opportunities: CreditSpreadTicket[];
  skipped: Array<{ ticker: string; reason: string }>;
  scanDate: string;
}

// ── Helpers ──────────────────────────────────────────────

async function getStockQuote(ticker: string): Promise<{ price: number; change: number; pctChange: number } | null> {
  // Primary: Finnhub (fast, low latency)
  const data = await finnhubFetch<{ c: number; d: number; dp: number }>(
    `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`
  );
  if (data?.c) {
    return { price: data.c, change: data.d ?? 0, pctChange: data.dp ?? 0 };
  }
  // Fallback: Yahoo Finance — critical for the position manager so stop-loss/profit-take
  // rules still fire even when Finnhub is rate-limited (55 req/min shared across all callers).
  const yq = await fetchQuote(ticker);
  if (yq?.price) {
    return { price: yq.price, change: 0, pctChange: 0 };
  }
  return null;
}

async function getEarningsDate(ticker: string): Promise<Date | null> {
  const data = await finnhubFetch<{ earningsCalendar?: Array<{ date?: string }> }>(
    `https://finnhub.io/api/v1/calendar/earnings?symbol=${ticker}&token=${FINNHUB_KEY}`
  );
  const future = (data?.earningsCalendar ?? [])
    .map(e => e.date ? new Date(e.date) : null)
    .filter((d): d is Date => d !== null && d > new Date())
    .sort((a, b) => a.getTime() - b.getTime());
  return future[0] ?? null;
}

/**
 * Detect pullback + trend direction.
 * Bullish entry: stock above SMA50 AND pulled back ≥3% from 20-day high.
 * Bearish entry: stock below SMA50 AND rallied ≥3% from 20-day low.
 */
async function analyzeTrend(ticker: string, currentPrice: number): Promise<{
  direction: 'BULL_PUT' | 'BEAR_CALL' | null;
  pullbackPct: number;
  aboveSma50: boolean;
  sma50: number | null;
}> {
  const bars = await fetchDailyBars(ticker, '3mo');
  if (!bars || bars.length < 50) return { direction: null, pullbackPct: 0, aboveSma50: true, sma50: null };

  const closes = bars.map(b => b.close);
  const sma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const aboveSma50 = currentPrice > sma50;

  const recent20 = bars.slice(-20);
  const high20 = Math.max(...recent20.map(b => b.high));
  const low20 = Math.min(...recent20.map(b => b.low));

  if (aboveSma50) {
    // Bullish trend — look for pullback from highs
    const pullbackPct = ((high20 - currentPrice) / high20) * 100;
    if (pullbackPct >= PULLBACK_THRESHOLD_PCT) {
      return { direction: 'BULL_PUT', pullbackPct, aboveSma50, sma50 };
    }
    return { direction: null, pullbackPct, aboveSma50, sma50 };
  } else {
    // Bearish trend — look for rally from lows
    const rallyPct = ((currentPrice - low20) / low20) * 100;
    if (rallyPct >= PULLBACK_THRESHOLD_PCT) {
      return { direction: 'BEAR_CALL', pullbackPct: rallyPct, aboveSma50, sma50 };
    }
    return { direction: null, pullbackPct: rallyPct, aboveSma50, sma50 };
  }
}

/**
 * Returns the stored IV rank (0–100) for a ticker based on the past year of
 * options_iv_history readings. Returns null when fewer than 10 data points
 * exist (new ticker still building history — treated as passing the gate).
 * Same computation as options-scanner.ts getStoredIvRank().
 */
async function getStoredIvRank(ticker: string): Promise<number | null> {
  const sb = getSupabase();
  const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data } = await sb
    .from('options_iv_history')
    .select('iv')
    .eq('ticker', ticker)
    .gte('date', yearAgo)
    .order('date', { ascending: false });
  if (!data || data.length < 10) return null;
  const ivs = data.map(r => r.iv as number);
  const current = ivs[0];
  const min52w = Math.min(...ivs);
  const max52w = Math.max(...ivs);
  if (max52w === min52w) return 50;
  return Math.round(((current - min52w) / (max52w - min52w)) * 100);
}

// ── Scanner ──────────────────────────────────────────────

async function scanTickerForSpread(
  ticker: string,
  accountBalance: number,
  openSpreadTickers: Set<string>,
): Promise<CreditSpreadTicket | { ticker: string; skipped: true; reason: string }> {
  const checks: Record<string, string> = {};

  // Gate 1: No duplicate spreads on same ticker
  if (openSpreadTickers.has(ticker)) {
    return { ticker, skipped: true, reason: 'duplicate_open_spread' };
  }

  // Gate 2: Get price
  const quote = await getStockQuote(ticker);
  if (!quote) return { ticker, skipped: true, reason: 'no_price_data' };
  const { price } = quote;

  if (price < MIN_STOCK_PRICE) {
    return { ticker, skipped: true, reason: `price_too_low:${price.toFixed(0)}` };
  }
  checks.price = `$${price.toFixed(2)}`;

  // Gate 3: Trend + timing
  const trend = await analyzeTrend(ticker, price);
  if (!trend.direction) {
    return { ticker, skipped: true, reason: `no_pullback_entry:pb${trend.pullbackPct.toFixed(1)}%_sma50:${trend.aboveSma50 ? 'above' : 'below'}` };
  }
  checks.trend = `${trend.direction}_pullback:${trend.pullbackPct.toFixed(1)}%`;

  // Gate 4: Earnings blackout — skip if earnings within 45 days (would be inside spread duration)
  const earningsDate = await getEarningsDate(ticker);
  if (earningsDate) {
    const daysToEarnings = Math.ceil((earningsDate.getTime() - Date.now()) / 86_400_000);
    if (daysToEarnings <= TARGET_DTE) {
      return { ticker, skipped: true, reason: `earnings_in_${daysToEarnings}d` };
    }
    checks.earnings = `${daysToEarnings}d_away_ok`;
  } else {
    checks.earnings = 'no_data';
  }

  // Gate 4.5: IV rank — only enter spreads in elevated-IV environments.
  // Selling for 33% of width when IVR=10 gives inadequate premium for the risk.
  // Null = fewer than 10 history points (new ticker) → allow through to build history.
  const ivRank = await getStoredIvRank(ticker);
  if (ivRank !== null && ivRank < MIN_IV_RANK) {
    return { ticker, skipped: true, reason: `low_iv_rank:${ivRank}` };
  }
  checks.ivRank = ivRank !== null ? `${ivRank}` : 'building_history';

  // Gate 5: Find credit spread strikes
  const right = trend.direction === 'BULL_PUT' ? 'P' as const : 'C' as const;
  const spread = await findSpreadStrikes(ticker, price, right, TARGET_DTE, MIN_CREDIT_PCT);
  if (!spread) {
    return { ticker, skipped: true, reason: 'no_qualifying_spread' };
  }
  checks.spread = `${spread.sellStrike}/${spread.buyStrike}_credit:${(spread.creditPct * 100).toFixed(0)}%`;

  // Gate 6: Position sizing — max 2% of account
  const riskPerContract = (spread.width - spread.netCredit) * 100;
  const maxRiskAllowed = accountBalance * MAX_RISK_PCT;
  const contracts = Math.max(1, Math.floor(maxRiskAllowed / riskPerContract));
  const totalMaxLoss = riskPerContract * contracts;
  checks.sizing = `${contracts}x_risk:$${totalMaxLoss.toFixed(0)}_max:$${maxRiskAllowed.toFixed(0)}`;

  const maxGain = spread.netCredit * 100 * contracts;
  const maxLoss = totalMaxLoss;

  return {
    ticker,
    direction: trend.direction,
    sellStrike: spread.sellStrike,
    buyStrike: spread.buyStrike,
    expiry: spread.expiry,
    dte: spread.dte,
    width: spread.width,
    netCredit: spread.netCredit,
    creditPct: spread.creditPct,
    maxGain,
    maxLoss,
    contracts,
    sellDelta: spread.sellDelta,
    buyDelta: spread.buyDelta,
    currentPrice: price,
    pullbackPct: trend.pullbackPct,
    aboveSma50: trend.aboveSma50,
    checksDetail: checks,
  };
}

/**
 * Run the credit spread scan across the options watchlist.
 * Finds trend-following credit spread opportunities and optionally auto-executes.
 */
export async function runCreditSpreadScan(
  accountBalance = 550_000,
  autoExecute = false,
): Promise<CreditSpreadScanResult> {
  const sb = getSupabase();
  const scanDate = new Date().toISOString().slice(0, 10);

  // Load active watchlist
  const { data: watchlist } = await sb
    .from('options_watchlist')
    .select('ticker, min_price, notes, tier')
    .eq('active', true)
    .order('ticker');

  if (!watchlist?.length) {
    return { opportunities: [], skipped: [], scanDate };
  }

  // Check current open spreads
  const { data: openSpreads } = await sb
    .from('paper_trades')
    .select('ticker, spread_max_loss')
    .eq('mode', 'CREDIT_SPREAD')
    .in('status', [...ACTIVE_STATUSES]);

  const openSpreadTickers = new Set((openSpreads ?? []).map(p => p.ticker));
  const openCount = openSpreadTickers.size;
  const totalSpreadRisk = (openSpreads ?? []).reduce((s, p) => s + (p.spread_max_loss ?? 0), 0);

  if (openCount >= MAX_SPREAD_POSITIONS) {
    console.log(`[Credit Spread Scanner] Max positions reached (${openCount}/${MAX_SPREAD_POSITIONS}), skipping`);
    return { opportunities: [], skipped: [], scanDate };
  }

  // Portfolio circuit breaker
  if (totalSpreadRisk >= accountBalance * MAX_PORTFOLIO_SPREAD_RISK) {
    console.log(`[Credit Spread Scanner] Portfolio risk cap hit ($${totalSpreadRisk.toFixed(0)} / $${(accountBalance * MAX_PORTFOLIO_SPREAD_RISK).toFixed(0)}), skipping`);
    return { opportunities: [], skipped: [], scanDate };
  }

  const opportunities: CreditSpreadTicket[] = [];
  const skipped: Array<{ ticker: string; reason: string }> = [];
  const total = watchlist.length;

  console.log(`\n[Credit Spread Scanner] ━━━ Scanning ${total} tickers | balance $${(accountBalance / 1000).toFixed(0)}k | open ${openCount}/${MAX_SPREAD_POSITIONS} | risk $${(totalSpreadRisk / 1000).toFixed(0)}k ━━━`);

  for (const [i, entry] of watchlist.entries()) {
    const num = `[${String(i + 1).padStart(2, '0')}/${total}]`;
    const ticker = entry.ticker;

    try {
      const result = await scanTickerForSpread(ticker, accountBalance, openSpreadTickers);

      if ('skipped' in result) {
        skipped.push({ ticker, reason: result.reason });
        console.log(`[Credit Spread Scanner] ${num} ${ticker.padEnd(5)} ✗  ${result.reason}`);
      } else {
        opportunities.push(result);
        openSpreadTickers.add(ticker);
        console.log(`[Credit Spread Scanner] ${num} ${ticker.padEnd(5)} ✅ ${result.direction} ${result.sellStrike}/${result.buyStrike} | credit ${(result.creditPct * 100).toFixed(0)}% | risk $${result.maxLoss.toFixed(0)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      skipped.push({ ticker, reason: `error:${msg.slice(0, 60)}` });
    }

  }

  // Sort by credit % descending (best risk-reward first)
  opportunities.sort((a, b) => b.creditPct - a.creditPct);

  console.log(`[Credit Spread Scanner] ━━━ Done — ${opportunities.length} opportunities, ${skipped.length} skipped ━━━\n`);

  // Auto-execute top opportunities
  if (autoExecute && opportunities.length > 0) {
    const remainingSlots = MAX_SPREAD_POSITIONS - openCount;
    const toExecute = opportunities
      .filter(o => o.creditPct >= PREFERRED_CREDIT_PCT)
      .slice(0, Math.min(remainingSlots, 3)); // max 3 per scan cycle

    for (const opp of toExecute) {
      try {
        await executeCreditSpread(opp);
      } catch (err) {
        console.error(`[Credit Spread Scanner] Failed to execute ${opp.ticker}:`, err);
      }
    }
  }

  // Log top opportunities (up to 5)
  for (const opp of opportunities.slice(0, 5)) {
    await createAutoTradeEvent({
      ticker: opp.ticker,
      mode: 'CREDIT_SPREAD',
      event_type: 'info',
      message: `${opp.direction}: ${opp.sellStrike}/${opp.buyStrike} exp ${opp.expiry} | credit ${(opp.creditPct * 100).toFixed(0)}% ($${opp.netCredit.toFixed(2)}) | ${opp.contracts}x risk $${opp.maxLoss.toFixed(0)}`,
      metadata: {
        direction: opp.direction,
        sellStrike: opp.sellStrike,
        buyStrike: opp.buyStrike,
        expiry: opp.expiry,
        creditPct: opp.creditPct,
        maxGain: opp.maxGain,
        maxLoss: opp.maxLoss,
        contracts: opp.contracts,
        pullbackPct: opp.pullbackPct,
      },
    }).catch(() => {});
  }

  // Always log a scan summary so the Options Wheel log shows the scan ran,
  // even on days with no qualifying setups.
  if (opportunities.length === 0) {
    await createAutoTradeEvent({
      ticker: 'SYSTEM',
      mode: 'CREDIT_SPREAD',
      event_type: 'info',
      message: `Credit spread scan: no qualifying setups today (${skipped.length} tickers scanned, none met criteria)`,
      metadata: { scanned: skipped.length, scanDate },
    }).catch(() => {});
  }

  return { opportunities, skipped, scanDate };
}

// ── Execution ────────────────────────────────────────────

async function executeCreditSpread(ticket: CreditSpreadTicket): Promise<void> {
  const sb = getSupabase();

  // Defense in depth (also enforced inside placeVerticalSpreadOrder).
  if (ticket.direction === 'BULL_PUT' && !(ticket.sellStrike > ticket.buyStrike)) {
    console.error(`[Credit Spread] Rejected ${ticket.ticker}: invalid BULL_PUT geometry ${ticket.sellStrike}/${ticket.buyStrike}`);
    await createAutoTradeEvent({
      ticker: ticket.ticker,
      mode: 'CREDIT_SPREAD',
      event_type: 'error',
      action: 'skipped',
      message: `Rejected BULL_PUT ${ticket.sellStrike}/${ticket.buyStrike} — sell strike must be above buy strike`,
    });
    return;
  }
  if (ticket.direction === 'BEAR_CALL' && !(ticket.sellStrike < ticket.buyStrike)) {
    console.error(`[Credit Spread] Rejected ${ticket.ticker}: invalid BEAR_CALL geometry ${ticket.sellStrike}/${ticket.buyStrike}`);
    await createAutoTradeEvent({
      ticker: ticket.ticker,
      mode: 'CREDIT_SPREAD',
      event_type: 'error',
      action: 'skipped',
      message: `Rejected BEAR_CALL ${ticket.sellStrike}/${ticket.buyStrike} — sell strike must be below buy strike`,
    });
    return;
  }
  if (!(ticket.netCredit > 0) || !(ticket.width > 0) || ticket.creditPct <= 0) {
    console.error(`[Credit Spread] Rejected ${ticket.ticker}: non-credit ticket credit=${ticket.netCredit} width=${ticket.width}`);
    return;
  }

  let ibOrderId: number | null = null;
  if (isConnected()) {
    try {
      const result = await placeVerticalSpreadOrder({
        symbol: ticket.ticker,
        right: ticket.direction === 'BULL_PUT' ? 'P' : 'C',
        sellStrike: ticket.sellStrike,
        buyStrike: ticket.buyStrike,
        expiry: ticket.expiry,
        contracts: ticket.contracts,
        limitPrice: ticket.netCredit,
        account: getDefaultAccount() ?? undefined,
      });
      ibOrderId = result.orderId;
    } catch (err) {
      console.error(`[Credit Spread] IB order failed for ${ticket.ticker}:`, err);
    }
  }

  const expiryIso = `${ticket.expiry.slice(0, 4)}-${ticket.expiry.slice(4, 6)}-${ticket.expiry.slice(6, 8)}`;

  // If IB placement failed, record as CANCELLED (not FILLED) so the position
  // monitor doesn't track it and generate phantom P&L from fallback stock prices.
  // Credit spreads are multi-leg IB orders — they cannot be paper-simulated safely.
  if (!ibOrderId) {
    console.warn(`[Credit Spread] IB order failed for ${ticket.ticker} — skipping paper_trade insert to prevent phantom P&L`);
    await createAutoTradeEvent({
      ticker: ticket.ticker,
      mode: 'CREDIT_SPREAD',
      event_type: 'warning',
      action: 'skipped',
      message: `${ticket.direction} ${ticket.sellStrike}/${ticket.buyStrike} — IB order failed, position NOT opened`,
      metadata: { direction: ticket.direction, sellStrike: ticket.sellStrike, buyStrike: ticket.buyStrike },
    });
    return;
  }

  await sb.from('paper_trades').insert({
    ticker: ticket.ticker,
    mode: 'CREDIT_SPREAD',
    signal: 'SELL',
    status: 'SUBMITTED',
    opened_at: new Date().toISOString(),
    filled_at: null,
    entry_price: ticket.netCredit,
    quantity: ticket.contracts,
    position_size: ticket.maxLoss,
    ib_order_id: ibOrderId.toString(),
    option_strike: ticket.sellStrike,
    option_expiry: expiryIso,
    option_premium: ticket.netCredit,
    option_contracts: ticket.contracts,
    option_delta: ticket.sellDelta,
    option_capital_req: ticket.maxLoss,
    option_annual_yield: (ticket.creditPct / (ticket.dte / 365)) * 100,
    spread_type: ticket.direction,
    spread_short_strike: ticket.sellStrike,
    spread_long_strike: ticket.buyStrike,
    spread_width: ticket.width,
    spread_net_credit: ticket.netCredit,
    spread_credit_pct: ticket.creditPct,
    spread_max_loss: ticket.maxLoss,
    spread_max_gain: ticket.maxGain,
    notes: `${ticket.direction}: sell $${ticket.sellStrike} / buy $${ticket.buyStrike} exp ${expiryIso} | ${ticket.contracts}x | credit $${(ticket.netCredit * 100 * ticket.contracts).toFixed(0)}`,
    scanner_reason: `Credit ${(ticket.creditPct * 100).toFixed(0)}% of $${ticket.width} width | pullback ${ticket.pullbackPct.toFixed(1)}% | risk $${ticket.maxLoss.toFixed(0)}`,
  });

  await createAutoTradeEvent({
    ticker: ticket.ticker,
    mode: 'CREDIT_SPREAD',
    event_type: 'success',
    action: 'executed',
    message: `Opened ${ticket.direction}: ${ticket.sellStrike}/${ticket.buyStrike} x${ticket.contracts} | credit $${(ticket.netCredit * 100 * ticket.contracts).toFixed(0)} | risk $${ticket.maxLoss.toFixed(0)}${ibOrderId ? ` (IB #${ibOrderId})` : ''}`,
    metadata: {
      ibOrderId,
      direction: ticket.direction,
      sellStrike: ticket.sellStrike,
      buyStrike: ticket.buyStrike,
      expiry: ticket.expiry,
      contracts: ticket.contracts,
      netCredit: ticket.netCredit,
      maxLoss: ticket.maxLoss,
    },
  });

  console.log(`[Credit Spread] ✅ Executed ${ticket.ticker} ${ticket.direction} ${ticket.sellStrike}/${ticket.buyStrike} x${ticket.contracts}`);
}

// ── Position Management (exit rules) ─────────────────────

/**
 * Check all open credit spread positions for exit signals.
 * Tony Zang's three rules:
 *   1. Take profit at 50% of max gain
 *   2. Stop loss at 100% of max gain (lost as much as you could have made)
 *   3. Time exit at 21 DTE
 */
export async function manageCreditSpreadPositions(): Promise<void> {
  const sb = getSupabase();

  const { data: positions } = await sb
    .from('paper_trades')
    .select('*')
    .eq('mode', 'CREDIT_SPREAD')
    .in('status', ['FILLED', 'PARTIAL']); // exclude SUBMITTED — those are GTC orders pending fill

  if (!positions?.length) return;

  console.log(`[Credit Spread Manager] Checking ${positions.length} open positions...`);

  for (const pos of positions) {
    try {
      // Compute DTE early — expiry backstop must NOT be blocked by a stale close stamp.
      // Jul 20 2026: AMD/ALAB/CRDO sat FILLED with unfilled close IDs for 33 days → assigned
      // into orphan shorts → reconcileIBShorts covered at ~−$22.6k.
      const expiryDate = pos.option_expiry ? new Date(pos.option_expiry) : null;
      const dte = expiryDate ? Math.ceil((expiryDate.getTime() - Date.now()) / 86_400_000) : 999;

      // Close order in-flight: only skip while the order is young AND unfilled AND not near expiry.
      // Otherwise cancel + clear ib_close_order_id and resume management / expiry settlement.
      if (pos.ib_close_order_id) {
        const closeOrderId = Number(pos.ib_close_order_id);
        const { data: closeFills } = await sb
          .from('ib_fills')
          .select('order_id')
          .eq('order_id', closeOrderId)
          .limit(1);

        if (closeFills?.length) {
          console.log(`[Credit Spread Manager] ${pos.ticker}: close order #${closeOrderId} has fills — waiting for trigger to finalize status`);
          continue;
        }

        // Age of the "close placed" event (fallback: treat as infinitely stale).
        const { data: closeEv } = await sb
          .from('auto_trade_events')
          .select('created_at')
          .eq('ticker', pos.ticker)
          .ilike('message', `%close order #${closeOrderId}%`)
          .order('created_at', { ascending: false })
          .limit(1);
        const placedAt = closeEv?.[0]?.created_at ? new Date(closeEv[0].created_at as string).getTime() : 0;
        const ageMs = placedAt > 0 ? Date.now() - placedAt : Number.POSITIVE_INFINITY;
        const nearExpiry = dte <= STALE_CLOSE_NEAR_EXPIRY_DTE;
        const expired = dte <= 0;
        const agedOut = ageMs >= STALE_CLOSE_ORDER_MS;

        if (!expired && !nearExpiry && !agedOut) {
          console.log(`[Credit Spread Manager] ${pos.ticker}: close order #${closeOrderId} in-flight (${(ageMs / 60_000).toFixed(0)}m old, ${dte}DTE) — waiting for fill`);
          continue;
        }

        if (isConnected() && Number.isFinite(closeOrderId)) {
          try {
            cancelOrder(closeOrderId);
            console.log(`[Credit Spread Manager] ${pos.ticker}: cancelled stale unfilled close #${closeOrderId}`);
          } catch (cancelErr) {
            console.warn(`[Credit Spread Manager] ${pos.ticker}: cancel stale close #${closeOrderId} failed — ${cancelErr instanceof Error ? cancelErr.message : cancelErr}`);
          }
        }
        await sb.from('paper_trades').update({ ib_close_order_id: null }).eq('id', pos.id);
        pos.ib_close_order_id = null;
        const reason = expired ? 'past_expiry' : nearExpiry ? 'near_expiry' : 'aged_out';
        console.warn(`[Credit Spread Manager] ${pos.ticker}: cleared stale ib_close_order_id #${closeOrderId} (${reason}, age=${(ageMs / 3_600_000).toFixed(1)}h, dte=${dte}) — resuming management`);
        await createAutoTradeEvent({
          ticker: pos.ticker,
          mode: 'CREDIT_SPREAD',
          event_type: 'warning',
          action: 'proceeding',
          message: `Cleared stale unfilled close #${closeOrderId} (${reason}, ${dte}DTE) — expiry/management unblocked`,
          metadata: { closeOrderId, reason, dte, ageMs, reconcile_type: 'stale_close_cleared' },
        });
        // Fall through — do not continue
      }

      // Bear Put Debit positions confirmed via IB screenshots — close direction is
      // INVERTED relative to our BULL_PUT leg convention. Attempting a buy-to-close
      // would create a new spread instead of closing the existing one.
      // These must be closed manually or via a corrected close order after investigation.
      if ((pos.notes as string | null)?.startsWith('BEAR_PUT_DEBIT_HOLD')) {
        console.warn(`[Credit Spread Manager] ${pos.ticker} ${pos.spread_short_strike}/${pos.spread_long_strike}: BEAR_PUT_DEBIT_HOLD — auto-close blocked. Manage manually in IB.`);
        continue;
      }

      // Bear Put Debit Spread positions are managed by bear-put-scanner.ts (manageBearPutPositions),
      // not by this credit spread manager. Skip here to avoid double-management.
      if (pos.spread_type === 'BEAR_PUT') {
        continue;
      }

      // Post-fill debit detector: if a "BULL_PUT" credit order filled as a net debit
      // (bought expensive leg / sold cheap), legs are inverted — freeze auto-close.
      if (
        pos.spread_type === 'BULL_PUT' &&
        pos.ib_order_id &&
        !(pos.notes as string | null)?.includes('BEAR_PUT_DEBIT_HOLD')
      ) {
        const { data: entryFills } = await sb
          .from('ib_fills')
          .select('side, quantity, fill_price')
          .eq('order_id', Number(pos.ib_order_id));
        if (entryFills && entryFills.length >= 2) {
          let sold = 0;
          let bought = 0;
          for (const f of entryFills) {
            const notional = Number(f.fill_price) * Number(f.quantity);
            if (f.side === 'SLD') sold += notional;
            else if (f.side === 'BOT') bought += notional;
          }
          const netCreditPerShare = (sold - bought) / Math.max(1, pos.option_contracts ?? pos.quantity ?? 1);
          if (netCreditPerShare < -0.05) {
            const holdNote = `BEAR_PUT_DEBIT_HOLD | entry filled as net debit $${Math.abs(netCreditPerShare).toFixed(2)}/sh (order #${pos.ib_order_id}) — auto-close blocked`;
            await sb.from('paper_trades').update({
              notes: holdNote,
            }).eq('id', pos.id);
            await createAutoTradeEvent({
              ticker: pos.ticker,
              mode: 'CREDIT_SPREAD',
              event_type: 'error',
              action: 'failed',
              message: `[Credit Spread] ⚠️ CRITICAL: ${pos.ticker} ${pos.spread_short_strike}/${pos.spread_long_strike} filled as DEBIT (inverted legs). Auto-close blocked — manage manually in IB.`,
              metadata: { netCreditPerShare, ibOrderId: pos.ib_order_id, reconcile_type: 'inverted_spread_debit' },
            });
            console.error(`[Credit Spread Manager] ${pos.ticker}: inverted debit fill detected (net $${netCreditPerShare.toFixed(2)}) — BEAR_PUT_DEBIT_HOLD`);
            continue;
          }
        }
      }

      const netCredit = pos.spread_net_credit ?? pos.entry_price ?? 0;
      const maxGainPerShare = netCredit;
      const contracts = pos.option_contracts ?? pos.quantity ?? 1;
      const maxGainTotal = maxGainPerShare * 100 * contracts;

      // ── Expiry backstop (dte ≤ 0) ──────────────────────────────────────────────────
      // The 21 DTE time-exit should have closed this spread weeks ago. If it somehow
      // slipped through (repeated IB order failures, connectivity gaps), settle it now
      // based on moneyness. This prevents spreads from sitting open indefinitely after
      // their expiry date.
      if (dte <= 0) {
        // Attempt a live quote to determine moneyness; fall back to max-loss if unavailable.
        const expiryQuote = await getStockQuote(pos.ticker);
        const stockPx = expiryQuote?.price ?? null;
        const spreadWidth = pos.spread_long_strike && pos.spread_short_strike
          ? Math.abs(pos.spread_long_strike - pos.spread_short_strike)
          : 0;

        let settledPnl = maxGainTotal; // default: assume expired OTM (keep full credit)
        let closeReason = 'expired_worthless';
        let settlementNotes: string | null = null;

        // If reconcileIBShorts already booked the assignment/exercise stock cover, do NOT
        // invent a second estimated spread P&L (would double-count lifetime losses).
        const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
        const { data: coverRows } = await sb
          .from('paper_trades')
          .select('id, pnl, ib_pnl, closed_at')
          .eq('ticker', pos.ticker)
          .eq('close_reason', 'ib_reconciliation_cover')
          .gte('closed_at', twoWeeksAgo)
          .order('closed_at', { ascending: false })
          .limit(1);
        const cover = coverRows?.[0] as { id: string; pnl: number | null; ib_pnl: number | null; closed_at: string } | undefined;
        if (cover) {
          settledPnl = 0;
          closeReason = 'expired_assigned_covered';
          settlementNotes = `Spread expired; stock cover P&L on paper_trade ${cover.id} (pnl=${cover.ib_pnl ?? cover.pnl}). Stale close unblocked ${new Date().toISOString()}.`;
        } else if (stockPx !== null && spreadWidth > 0) {
          if (pos.spread_type === 'BULL_PUT') {
            if (stockPx < (pos.spread_long_strike ?? 0)) {
              // Stock below both legs → max loss
              settledPnl = maxGainTotal - spreadWidth * 100 * contracts;
              closeReason = 'expired_max_loss';
            } else if (stockPx < (pos.spread_short_strike ?? 0)) {
              // Between legs → partial loss (short leg assigned, long leg worthless)
              const intrinsic = (pos.spread_short_strike ?? 0) - stockPx;
              settledPnl = maxGainTotal - intrinsic * 100 * contracts;
              closeReason = 'expired_partial_loss';
            }
            // else: stock above short strike → both legs expire worthless, keep full credit
          } else {
            // BEAR_CALL
            if (stockPx > (pos.spread_long_strike ?? Infinity)) {
              settledPnl = maxGainTotal - spreadWidth * 100 * contracts;
              closeReason = 'expired_max_loss';
            } else if (stockPx > (pos.spread_short_strike ?? Infinity)) {
              const intrinsic = stockPx - (pos.spread_short_strike ?? 0);
              settledPnl = maxGainTotal - intrinsic * 100 * contracts;
              closeReason = 'expired_partial_loss';
            }
          }
        } else if (stockPx === null) {
          // Can't get quote — conservatively assume max loss to avoid phantom profits
          settledPnl = maxGainTotal - (spreadWidth > 0 ? spreadWidth * 100 * contracts : maxGainTotal * 2);
          closeReason = 'expired_max_loss';
          console.warn(`[Credit Spread Manager] ${pos.ticker}: expired with no quote — recording max loss conservatively`);
        }

        // Stamp closed_at on the expiry date (not "now") so late settlements don't
        // inflate Today's Activity on the day the zombie was finally cleaned up.
        const expiryClosedAt = pos.option_expiry
          ? `${pos.option_expiry}T20:00:00.000Z`
          : new Date().toISOString();

        await recordTradeClose({
          tradeId: pos.id,
          closePrice: 0,
          closeReason,
          status: 'CLOSED',
          accountType: 'paper',
          overridePnl: settledPnl,
          overridePnlPct: maxGainTotal > 0 ? (settledPnl / maxGainTotal) * 100 : 0,
          overridePnlSource: closeReason === 'expired_assigned_covered' ? 'ib_assignment' : 'estimated',
          extraUpdates: {
            closed_at: expiryClosedAt,
            ...(settlementNotes ? { notes: settlementNotes } : {}),
          },
        });
        await createAutoTradeEvent({
          ticker: pos.ticker,
          mode: 'CREDIT_SPREAD',
          event_type: closeReason === 'expired_worthless' ? 'info' : 'warning',
          action: 'closed',
          message: `${pos.spread_type} ${pos.spread_short_strike}/${pos.spread_long_strike} expired — ${closeReason} | settled P&L $${settledPnl.toFixed(0)}`,
          metadata: { closeReason, settledPnl, dte, stockPx, coverId: cover?.id ?? null },
        });
        console.log(`[Credit Spread Manager] EXPIRY BACKSTOP: ${pos.ticker} ${pos.spread_type} → ${closeReason} P&L $${settledPnl.toFixed(0)}`);
        continue;
      }

      // Get current spread value (what it would cost to buy back)
      const quote = await getStockQuote(pos.ticker);
      if (!quote) {
        console.warn(`[Credit Spread Manager] ${pos.ticker}: no stock quote (Finnhub + Yahoo both failed) — skipping this cycle`);
        continue;
      }

      const spreadRight = pos.spread_type === 'BULL_PUT' ? 'P' as const : 'C' as const;
      const expiryStr = pos.option_expiry ? pos.option_expiry.replace(/-/g, '') : '';

      // Price the HELD spread by fetching bid/ask for each specific leg.
      // Buy-to-close cost = short leg ask (to buy back) − long leg bid (to sell back).
      // Fallback: when IB chain data is unavailable, estimate value from intrinsic value
      // so the stop-loss and profit-take rules can still fire. Without this fallback, a
      // deeply ITM spread always shows P&L = 0 and the stop loss never triggers.
      let currentSpreadValue = netCredit;
      let pricingSource: 'greeks' | 'intrinsic' | 'fallback' = 'fallback';

      if (expiryStr && pos.spread_short_strike && pos.spread_long_strike) {
        const [shortGreeks, longGreeks] = await Promise.all([
          getOptionGreeksForContract(pos.ticker, pos.spread_short_strike, expiryStr, spreadRight, quote.price).catch(() => null),
          getOptionGreeksForContract(pos.ticker, pos.spread_long_strike, expiryStr, spreadRight, quote.price).catch(() => null),
        ]);
        if (shortGreeks && longGreeks) {
          // Live greeks available — use actual bid/ask
          const buybackCost = shortGreeks.ask - longGreeks.bid;
          currentSpreadValue = Math.max(0, buybackCost);
          pricingSource = 'greeks';
        } else {
          // Greeks unavailable — estimate from intrinsic value using stock price.
          // For a BULL_PUT spread, intrinsic value of the spread = max(0, short_strike - stock)
          // capped at the spread width. Add a small time-value buffer (10% of width).
          const stockPx = quote.price;
          const spreadWidth = pos.spread_short_strike - pos.spread_long_strike;
          let intrinsic: number;
          if (pos.spread_type === 'BULL_PUT') {
            intrinsic = Math.min(spreadWidth, Math.max(0, pos.spread_short_strike - stockPx));
          } else {
            // BEAR_CALL
            intrinsic = Math.min(spreadWidth, Math.max(0, stockPx - pos.spread_short_strike));
          }
          // Add 10% of width as time-value premium — conservative so we don't over-trigger profit-take
          const timeValueBuffer = spreadWidth * 0.10;
          currentSpreadValue = intrinsic + timeValueBuffer;
          pricingSource = 'intrinsic';
          console.log(`[Credit Spread Manager] ${pos.ticker}: greeks unavailable, using intrinsic estimate $${currentSpreadValue.toFixed(2)} (stock $${stockPx.toFixed(2)} vs $${pos.spread_short_strike}/$${pos.spread_long_strike})`);
        }
      }

      // P&L = what we sold for - what it costs to buy back
      const pnlPerShare = netCredit - currentSpreadValue;
      const pnlTotal = pnlPerShare * 100 * contracts;
      const pnlPctOfMaxGain = maxGainTotal > 0 ? (pnlTotal / maxGainTotal) * 100 : 0;

      let closeReason: string | null = null;

      // Rule 1: Take profit at 50% of max gain
      if (pnlPctOfMaxGain >= 50) {
        closeReason = 'profit_take_50pct';
      }

      // Rule 2: Stop loss.
      // TastyTrade standard: close when the spread costs 2× credit to buy back.
      // Safety cap: if 2× credit > 90% of spread width (high-credit spreads, common in
      // elevated-IV environments), that threshold is unreachable — the spread can only
      // trade up to its full width. Cap at 90% of width so we always have a reachable stop.
      const spreadWidth = pos.spread_short_strike - pos.spread_long_strike;
      const stopSpreadValue = Math.min(2 * netCredit, spreadWidth * 0.90);
      if (currentSpreadValue >= stopSpreadValue) {
        closeReason = 'stop_loss_100pct';
      }

      // Rule 3: Time exit at 21 DTE
      if (dte <= 21 && !closeReason) {
        closeReason = 'time_exit_21dte';
      }

      // Diagnostics: log current state every cycle so we can monitor without events
      console.log(`[Credit Spread Manager] ${pos.ticker} ${pos.spread_type} ${pos.spread_short_strike}/${pos.spread_long_strike}: spreadVal=$${currentSpreadValue.toFixed(2)} credit=$${netCredit.toFixed(2)} stop=$${stopSpreadValue.toFixed(2)} P&L=$${pnlTotal.toFixed(0)} (${pnlPctOfMaxGain.toFixed(0)}%) ${dte}DTE [${pricingSource}]`);

      if (closeReason) {
        console.log(`[Credit Spread Manager] ${pos.ticker} → ${closeReason} (P&L: $${pnlTotal.toFixed(0)}, ${pnlPctOfMaxGain.toFixed(0)}% of max gain, ${dte} DTE, priced via ${pricingSource})`);

        // Place IB buy-to-close spread order before marking CLOSED
        let ibCloseOrderId: number | null = null;
        const ibConnected = isConnected();
        console.log(`[Credit Spread Manager] ${pos.ticker} close attempt — IB connected: ${ibConnected}, short_strike: ${pos.spread_short_strike}, long_strike: ${pos.spread_long_strike}, option_expiry: ${pos.option_expiry}`);
        if (ibConnected && pos.spread_short_strike && pos.spread_long_strike && pos.option_expiry) {
          const spreadRight = pos.spread_type === 'BULL_PUT' ? 'P' as const : 'C' as const;
          const spreadExpiry = pos.option_expiry.replace(/-/g, '');
          const closeLimit = Math.max(0.01, currentSpreadValue * 1.05);
          try {
            const closeResult = await placeVerticalSpreadOrder({
              symbol: pos.ticker,
              right: spreadRight,
              sellStrike: pos.spread_short_strike,
              buyStrike: pos.spread_long_strike,
              expiry: spreadExpiry,
              contracts: contracts,
              limitPrice: closeLimit,
              action: 'BUY',
              account: getDefaultAccount() ?? undefined,
            });
            ibCloseOrderId = closeResult.orderId;
            console.log(`[Credit Spread Manager] IB buy-to-close dispatched for ${pos.ticker} (order #${ibCloseOrderId})`);
            // Pre-stamp ib_close_order_id immediately so the trigger can match incoming
            // fill events even if recordTradeClose() hasn't written to the DB yet.
            // Without this, fills arriving before the recordTradeClose write create ghost records.
            await getSupabase().from('paper_trades').update({
              ib_close_order_id: String(ibCloseOrderId),
            }).eq('id', pos.id);
          } catch (ibErr) {
            console.warn(`[Credit Spread Manager] IB buy-to-close FAILED for ${pos.ticker}: ${ibErr instanceof Error ? ibErr.message : ibErr}`);
          }
        }

        if (!ibCloseOrderId) {
          // IB connected but order placement failed — skip this cycle, retry next run
          if (ibConnected) {
            console.warn(`[Credit Spread Manager] ${pos.ticker} — close trigger ${closeReason} but IB close order failed (connected=true), leaving position open for retry`);
            await createAutoTradeEvent({
              ticker: pos.ticker,
              mode: 'CREDIT_SPREAD',
              event_type: 'warning',
              action: 'skipped',
              message: `${pos.ticker} ${closeReason} triggered but IB buy-to-close failed — position left open for retry`,
              metadata: { closeReason, pnl: pnlTotal, dte, pnlPctOfMaxGain },
            });
          } else {
            // IB disconnected — fall back to estimated P&L close so the position doesn't run dark
            await recordTradeClose({
              tradeId: pos.id,
              closePrice: currentSpreadValue,
              closeReason,
              status: 'CLOSED',
              accountType: 'paper',
              overridePnl: pnlTotal,
              overridePnlPct: maxGainTotal > 0 ? (pnlTotal / maxGainTotal) * 100 : 0,
              overridePnlSource: 'estimated',
            });
            await createAutoTradeEvent({
              ticker: pos.ticker,
              mode: 'CREDIT_SPREAD',
              event_type: 'warning',
              action: 'closed',
              message: `Closed ${pos.spread_type}: ${pos.spread_short_strike}/${pos.spread_long_strike} | ${closeReason} | P&L $${pnlTotal.toFixed(0)} (estimated — IB disconnected, priced via ${pricingSource})`,
              metadata: { closeReason, pnl: pnlTotal, dte, pnlPctOfMaxGain, pricingSource },
            });
          }
          continue;
        }

        // IB order placed successfully — ib_close_order_id is already stamped on the DB record.
        // The Supabase trigger will confirm the close with actual fill prices when both legs land.
        // Do NOT call recordTradeClose here — that would write an estimated P&L that the trigger
        // cannot correct (realized_pnl=null for combo fills).
        await createAutoTradeEvent({
          ticker: pos.ticker,
          mode: 'CREDIT_SPREAD',
          event_type: 'info',
          action: 'proceeding',
          message: `${pos.spread_type} ${pos.spread_short_strike}/${pos.spread_long_strike}: close order #${ibCloseOrderId} placed (${closeReason}, est P&L $${pnlTotal.toFixed(0)}, priced via ${pricingSource}) — waiting for fill confirmation`,
          metadata: { closeReason, estimatedPnl: pnlTotal, dte, ibCloseOrderId, pricingSource },
        });
      }
    } catch (err) {
      console.error(`[Credit Spread Manager] Error managing ${pos.ticker}:`, err);
    }
  }
}

/**
 * Cancel stale SUBMITTED credit spread orders that IB never filled.
 *
 * A GTC combo order that stays SUBMITTED for >2 trading days was either
 * rejected silently by IB (e.g., Limit 0.00 bug pre-fix) or the market
 * never came to the price. Either way, cancel it in IB and mark it CANCELLED
 * in the DB so the UI stops showing it as an open position.
 *
 * Runs as part of the existing 30-min management cron — no extra schedule needed.
 */
export async function purgeStaleCreditSpreadOrders(): Promise<void> {
  const sb = getSupabase();

  // 2 trading days ≈ 2 × 6.5 h = 13 h of market time.
  // Using 2 calendar days (48 h) as a simple, conservative proxy.
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { data: stale } = await sb
    .from('paper_trades')
    .select('id, ticker, ib_order_id, opened_at, spread_short_strike, spread_long_strike')
    .eq('mode', 'CREDIT_SPREAD')
    .eq('status', 'SUBMITTED')
    .lt('opened_at', cutoff);

  if (!stale?.length) return;

  console.log(`[Credit Spread] Purging ${stale.length} stale SUBMITTED order(s)...`);

  const { isConnected: ibConnected, cancelOrder } = await import('../ib-connection.js');

  for (const row of stale) {
    const ibOrderId = row.ib_order_id ? Number(row.ib_order_id) : null;

    // Ask IB to cancel the GTC order if we have a reference and are connected.
    if (ibOrderId && ibConnected()) {
      try {
        cancelOrder(ibOrderId);
        console.log(`[Credit Spread] Cancelled IB order #${ibOrderId} for ${row.ticker}`);
      } catch (err) {
        console.warn(`[Credit Spread] Could not cancel IB order #${ibOrderId}:`, err);
      }
    }

    await sb
      .from('paper_trades')
      .update({ status: 'CANCELLED', close_reason: 'stale_unfilled_gtc' })
      .eq('id', row.id);

    await createAutoTradeEvent({
      ticker: row.ticker,
      mode: 'CREDIT_SPREAD',
      event_type: 'warning',
      action: 'skipped',
      message: `Stale GTC order purged — ${row.spread_short_strike}/${row.spread_long_strike} never filled after 48h${ibOrderId ? ` (IB #${ibOrderId})` : ''}`,
      metadata: { ibOrderId, openedAt: row.opened_at },
    });

    console.log(`[Credit Spread] Marked ${row.ticker} spread CANCELLED (stale GTC, opened ${row.opened_at})`);
  }
}
