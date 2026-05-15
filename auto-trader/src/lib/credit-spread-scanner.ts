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
 */

import { findSpreadStrikes, type SpreadStrikeResult } from './options-chain.js';
import { getSupabase, createAutoTradeEvent } from './supabase.js';
import { ACTIVE_STATUSES } from '../../../shared/trade-status-sets.js';
import { fetchDailyBars, fetchQuote, sma as calcSma } from './yahoo-finance.js';
import { isConnected, placeVerticalSpreadOrder, getDefaultAccount } from '../ib-connection.js';

// ── Constants ────────────────────────────────────────────

const FINNHUB_KEY = process.env.FINNHUB_API_KEY ?? '';
const MIN_CREDIT_PCT = 0.33;           // collect at least 33% of width
const PREFERRED_CREDIT_PCT = 0.40;     // Tony's sweet spot: 40%+
const MAX_RISK_PCT = 0.02;             // max 2% of account per trade
const MAX_SPREAD_POSITIONS = 8;        // max concurrent credit spreads
const TARGET_DTE = 45;
const MIN_STOCK_PRICE = 20;
const MAX_PORTFOLIO_SPREAD_RISK = 0.30; // circuit breaker: max 30% of account in spread risk
const PULLBACK_THRESHOLD_PCT = 3;      // stock pulled back ≥3% from recent high = entry signal
const TREND_SMA_DAYS = 50;             // stock must be above/below 50-SMA for trend confirmation

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

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json() as T;
  } catch { return null; }
}

async function getStockQuote(ticker: string): Promise<{ price: number; change: number; pctChange: number } | null> {
  const data = await fetchJson<{ c: number; d: number; dp: number }>(
    `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`
  );
  if (!data?.c) return null;
  return { price: data.c, change: data.d ?? 0, pctChange: data.dp ?? 0 };
}

async function getEarningsDate(ticker: string): Promise<Date | null> {
  const data = await fetchJson<{ earningsCalendar?: Array<{ date?: string }> }>(
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

    await new Promise(r => setTimeout(r, 800));
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

  // Log top opportunities
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

  return { opportunities, skipped, scanDate };
}

// ── Execution ────────────────────────────────────────────

async function executeCreditSpread(ticket: CreditSpreadTicket): Promise<void> {
  const sb = getSupabase();

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

  await sb.from('paper_trades').insert({
    ticker: ticket.ticker,
    mode: 'CREDIT_SPREAD',
    signal: 'SELL',
    status: ibOrderId ? 'SUBMITTED' : 'FILLED',
    opened_at: new Date().toISOString(),
    filled_at: ibOrderId ? null : new Date().toISOString(),
    entry_price: ticket.netCredit,
    quantity: ticket.contracts,
    position_size: ticket.maxLoss,
    ib_order_id: ibOrderId?.toString() ?? null,
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
    .in('status', [...ACTIVE_STATUSES]);

  if (!positions?.length) return;

  console.log(`[Credit Spread Manager] Checking ${positions.length} open positions...`);

  for (const pos of positions) {
    try {
      const netCredit = pos.spread_net_credit ?? pos.entry_price ?? 0;
      const maxGainPerShare = netCredit;
      const contracts = pos.option_contracts ?? pos.quantity ?? 1;
      const maxGainTotal = maxGainPerShare * 100 * contracts;

      // Get current spread value (what it would cost to buy back)
      const quote = await getStockQuote(pos.ticker);
      if (!quote) continue;

      // Estimate current spread value using the original spread parameters
      const spread = await findSpreadStrikes(
        pos.ticker,
        quote.price,
        pos.spread_type === 'BULL_PUT' ? 'P' : 'C',
        undefined,
        0, // no min credit for valuation
      );

      // If can't re-price, use DTE-based estimate
      const expiryDate = pos.option_expiry ? new Date(pos.option_expiry) : null;
      const dte = expiryDate ? Math.ceil((expiryDate.getTime() - Date.now()) / 86_400_000) : 999;

      let currentSpreadValue = netCredit; // default: no P&L
      if (spread) {
        currentSpreadValue = spread.netCredit;
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

      // Rule 2: Stop loss at 100% of max gain lost
      if (pnlTotal <= -maxGainTotal) {
        closeReason = 'stop_loss_100pct';
      }

      // Rule 3: Time exit at 21 DTE
      if (dte <= 21 && !closeReason) {
        closeReason = 'time_exit_21dte';
      }

      if (closeReason) {
        console.log(`[Credit Spread Manager] ${pos.ticker} → ${closeReason} (P&L: $${pnlTotal.toFixed(0)}, ${pnlPctOfMaxGain.toFixed(0)}% of max gain, ${dte} DTE)`);

        await sb.from('paper_trades').update({
          status: 'CLOSED',
          close_reason: closeReason,
          close_price: currentSpreadValue,
          pnl: pnlTotal,
          pnl_percent: maxGainTotal > 0 ? (pnlTotal / maxGainTotal) * 100 : 0,
          closed_at: new Date().toISOString(),
        }).eq('id', pos.id);

        await createAutoTradeEvent({
          ticker: pos.ticker,
          mode: 'CREDIT_SPREAD',
          event_type: pnlTotal >= 0 ? 'success' : 'warning',
          action: 'closed',
          message: `Closed ${pos.spread_type}: ${pos.spread_short_strike}/${pos.spread_long_strike} | ${closeReason} | P&L $${pnlTotal.toFixed(0)} (${pnlPctOfMaxGain.toFixed(0)}% of max)`,
          metadata: { closeReason, pnl: pnlTotal, dte, pnlPctOfMaxGain },
        });
      }
    } catch (err) {
      console.error(`[Credit Spread Manager] Error managing ${pos.ticker}:`, err);
    }
  }
}
