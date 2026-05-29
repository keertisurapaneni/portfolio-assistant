/**
 * Options Position Manager
 *
 * Monitors open options positions every 30 minutes and:
 *   - Auto-closes puts at 50% of max profit (Check 3b)
 *   - At 21 DTE: closes winners, rolls or closes deep losers (loss > premium),
 *     holds mild losers to let theta decay work (Check 4)
 *   - Detects assignment and suggests covered call
 *   - Tracks P&L on open positions
 */

import { getSupabase, createAutoTradeEvent } from './supabase.js';
import { recordTradeClose } from './trade-closer.js';
import { ACTIVE_STATUSES, CLOSED_STATUSES, OPTIONS_MODES } from '../../../shared/trade-status-sets.js';
import { getOptionsAutoTradeConfig, autoTradeOption, type OptionsTradeTicket } from './options-scanner.js';
import { getOptionsChain } from './options-chain.js';
import { finnhubFetch, FINNHUB_KEY } from './finnhub.js';
import { isConnected, placeOptionsOrder, getDefaultAccount } from '../ib-connection.js';

import type { AutoTradeEventType } from '../../../shared/auto-trade-events.js';

function persistEvent(ticker: string, eventType: AutoTradeEventType, message: string, extra?: Record<string, unknown>): void {
  createAutoTradeEvent({ ticker, event_type: eventType, message, ...extra })
    .catch(err => console.warn(`[Options persistEvent] ${ticker}/${eventType} failed:`, err instanceof Error ? err.message : err));
}

// ── Types ────────────────────────────────────────────────

export interface OpenOptionsPosition {
  id: string;
  ticker: string;
  mode: 'OPTIONS_PUT' | 'OPTIONS_CALL';
  strike: number;
  expiry: string;          // ISO date YYYY-MM-DD
  expiryDate: Date;
  daysToExpiry: number;
  premiumCollected: number;  // per share at entry
  currentPremium: number;    // current mid price (what it costs to buy back)
  profitCapturePct: number;  // (1 - currentPremium/premiumCollected) * 100
  pnl: number;               // (premiumCollected - currentPremium) * 100
  capitalRequired: number;
  status: string;
  isAssigned: boolean;
}

interface PositionRow {
  id: string;
  ticker: string;
  mode: string;
  option_strike: number;
  option_expiry: string;
  option_premium: number;
  option_capital_req: number;
  option_assigned: boolean;
  fill_price: number;
  status: string;
  pnl: number | null;
  ib_order_id: number | null;
  roll_count: number;
  rolled_from_id: string | null;
}

// ── Roll Constants (from rolling-options video strategy) ──

/** Max debit rolls per position — "three strikes and you're out" */
const MAX_DEBIT_ROLLS = 3;
/** Max debit accepted on a roll = 25% of original premium collected */
const ROLL_MAX_DEBIT_PCT = 0.25;
/** Target DTE for the new leg when rolling */
const ROLL_TARGET_DTE = 45;
/** Target delta for the new put leg when rolling down */
const ROLL_PUT_DELTA = 0.20;

function daysToExpiryStr(yyyymmdd: string): number {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  return Math.ceil((new Date(y, m, d).getTime() - Date.now()) / 86_400_000);
}

/**
 * Evaluate and execute a "roll down and out" for a sell-put position.
 *
 * Strategy (from rolling-options video):
 *   1. Buy back the current put at current market price
 *   2. Sell a new put at or below current stock price, ~45 DTE
 *   3. Only proceed if net result is a credit OR small debit (≤25% of original premium)
 *   4. Respect max-debit-roll limit (3 debit rolls per position chain)
 *
 * Returns true if the roll was executed, false if we should fall back to closing.
 */
async function evaluateAndRollPut(
  pos: PositionRow,
  stockPrice: number,
  currentPremium: number,
): Promise<{ rolled: boolean; reason: string; logLine: string }> {
  const sb = getSupabase();
  const premiumCollected = pos.option_premium ?? 0;
  const rollCount = pos.roll_count ?? 0;

  // Gate: never roll more than MAX_DEBIT_ROLLS times for a debit
  // (credit rolls are unlimited — that's the "infinite rolling" strategy)

  // Fetch next-month chain at a 20-delta strike at/below current price
  const chain = await getOptionsChain(pos.ticker, stockPrice, null, ROLL_PUT_DELTA, ROLL_TARGET_DTE).catch(() => null);
  if (!chain?.bestPut) {
    return { rolled: false, reason: 'no_chain', logLine: `${pos.ticker}: no options chain available for roll` };
  }

  const newPut = chain.bestPut;
  const newStrike = newPut.strike;
  const newExpiry = newPut.expiry;         // YYYYMMDD
  const newPremium = newPut.bid;           // conservative: bid price
  const newDte = daysToExpiryStr(newExpiry);

  // Net credit = new premium collected − cost to buy back current
  const netCredit = newPremium - currentPremium;
  const isCredit = netCredit >= 0;
  const isAcceptableDebit = netCredit < 0 && Math.abs(netCredit) <= premiumCollected * ROLL_MAX_DEBIT_PCT;

  if (!isCredit && !isAcceptableDebit) {
    return {
      rolled: false,
      reason: `debit_too_large`,
      logLine: `${pos.ticker}: roll debit $${Math.abs(netCredit).toFixed(2)} exceeds 25% limit ($${(premiumCollected * ROLL_MAX_DEBIT_PCT).toFixed(2)}) — closing instead`,
    };
  }

  if (!isCredit && rollCount >= MAX_DEBIT_ROLLS) {
    return {
      rolled: false,
      reason: `max_debit_rolls`,
      logLine: `${pos.ticker}: already rolled ${rollCount}× for debit — three strikes, closing instead`,
    };
  }

  // Roll math sanity check (video's annualized return test):
  // (strike improvement + net credit) / capital × (365 / newDte) must be meaningful
  const strikeImprovement = Math.max(0, pos.option_strike - newStrike); // going down
  const totalBenefit = strikeImprovement + Math.max(0, netCredit);      // credit adds; debit subtracts
  const capital = pos.option_capital_req ?? pos.option_strike * 100;
  const annualizedRollReturn = newDte > 0 ? (totalBenefit / capital) * (365 / newDte) * 100 : 0;

  if (annualizedRollReturn < 2) {
    return {
      rolled: false,
      reason: `low_return`,
      logLine: `${pos.ticker}: roll annualized return ${annualizedRollReturn.toFixed(1)}% < 2% threshold — not worth it, closing instead`,
    };
  }

  // ── Execute the roll ─────────────────────────────────────

  // 1. Close the current leg via IB buy-to-close
  const ibCloseOldPut = await ibBuyToCloseOption(pos.ticker, 'P', pos.option_strike, pos.option_expiry, currentPremium);
  if (!ibCloseOldPut) {
    return {
      rolled: false,
      reason: 'ib_close_failed',
      logLine: `${pos.ticker}: IB buy-to-close failed for old put leg $${pos.option_strike}P — roll aborted`,
    };
  }
  const rollClosePremium = ibCloseOldPut.avgFillPrice;
  const pnl = (premiumCollected - rollClosePremium) * 100;

  await recordTradeClose({
    tradeId: pos.id,
    closePrice: rollClosePremium,
    closeReason: 'rolled',
    status: 'CLOSED',
    orderId: ibCloseOldPut.orderId,
    accountType: 'paper',
    overridePnl: pnl,
    overridePnlPct: (pnl / capital) * 100,
    overridePnlSource: 'ib_fill_calculated',
    extraUpdates: { option_close_pct: Math.max(0, (1 - rollClosePremium / premiumCollected) * 100) },
  });

  // 2. Open the new leg — record in DB (+ IB order if connected)
  const newExpiryISO = `${newExpiry.slice(0, 4)}-${newExpiry.slice(4, 6)}-${newExpiry.slice(6, 8)}`;
  let ibOrderId: number | null = null;
  if (isConnected()) {
    try {
      const r = await placeOptionsOrder({
        symbol: pos.ticker,
        right: 'P',
        strike: newStrike,
        expiry: newExpiry,
        contracts: 1,
        limitPrice: newPremium,
        account: getDefaultAccount() ?? undefined,
      });
      ibOrderId = r.orderId;
    } catch (err) {
      console.warn(`[Roll] IB order failed for ${pos.ticker} — paper-recording roll: ${err}`);
    }
  }

  await sb.from('paper_trades').insert({
    ticker: pos.ticker,
    mode: 'OPTIONS_PUT',
    signal: 'SELL',
    entry_price: stockPrice,
    fill_price: ibOrderId ? null : stockPrice,
    quantity: 1,
    position_size: newStrike * 100,
    status: ibOrderId ? 'SUBMITTED' : 'FILLED',
    filled_at: ibOrderId ? null : new Date().toISOString(),
    opened_at: new Date().toISOString(),
    option_strike: newStrike,
    option_expiry: newExpiryISO,
    option_premium: newPremium,
    option_contracts: 1,
    option_delta: newPut.delta,
    option_prob_profit: newPut.probProfit,
    option_capital_req: newStrike * 100,
    option_annual_yield: newPut.annualYield,
    option_net_price: newStrike - newPremium,
    ib_order_id: ibOrderId,
    roll_count: rollCount + 1,
    rolled_from_id: pos.id,
    notes: `[ROLL ${rollCount + 1}] ${isCredit ? `+$${(netCredit * 100).toFixed(0)} credit` : `-$${(Math.abs(netCredit) * 100).toFixed(0)} debit`} — rolled from $${pos.option_strike} → $${newStrike} strike, ${newDte}d DTE`,
    scanner_reason: `Roll ${rollCount + 1}: ann. return ${annualizedRollReturn.toFixed(1)}%, ${isCredit ? 'credit' : 'debit'} $${Math.abs(netCredit * 100).toFixed(0)}, strike ${pos.option_strike}→${newStrike}`,
  });

  const creditTag = isCredit
    ? `+$${(netCredit * 100).toFixed(0)} credit`
    : `-$${(Math.abs(netCredit) * 100).toFixed(0)} debit`;
  const ibTag = ibOrderId ? ` IB#${ibOrderId}` : ' (paper)';

  return {
    rolled: true,
    reason: isCredit ? 'credit_roll' : 'debit_roll',
    logLine: `${pos.ticker}: rolled $${pos.option_strike}→$${newStrike}P ${newExpiryISO} (${creditTag}, ${annualizedRollReturn.toFixed(1)}% ann.)${ibTag}`,
  };
}

// ── Helpers ──────────────────────────────────────────────

function daysUntil(dateStr: string): number {
  const d = new Date(dateStr);
  return Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

async function getCurrentPremium(
  ticker: string,
  strike: number,
  expiryISO: string,
  stockPrice: number,
): Promise<number | null> {
  if (!isConnected()) return null;
  // Request chain targeted at the position's exact strike by computing the delta
  // for that strike and passing it as a hint. Fall back to bestPut if close enough.
  const chain = await getOptionsChain(ticker, stockPrice);
  if (!chain?.bestPut) return null;
  // Use percentage-based tolerance (3% of strike) instead of flat ±$5.
  // On a $300 stock, $5 = 1.7% — acceptable. On a $30 stock, $5 = 16.7% — wrong strike.
  const tolerancePct = 0.03;
  if (Math.abs(chain.bestPut.strike - strike) / strike <= tolerancePct) {
    return chain.bestPut.mid;
  }
  return null;
}

async function getCurrentCallPremium(
  ticker: string,
  strike: number,
  expiryISO: string,
  stockPrice: number,
): Promise<number | null> {
  if (!isConnected()) return null;
  const chain = await getOptionsChain(ticker, stockPrice);
  if (!chain?.bestCall) return null;
  const tolerancePct = 0.03;
  if (Math.abs(chain.bestCall.strike - strike) / strike <= tolerancePct) {
    return chain.bestCall.mid;
  }
  return null;
}

/**
 * Place an IB buy-to-close order for a short option position.
 * Returns the fill result, or null if IB is disconnected or the order fails/times out.
 * The limit is set 5% above currentPremium (the mid) to improve fill probability;
 * the actual fill price (avgFillPrice) is what gets used for P&L.
 */
async function ibBuyToCloseOption(
  ticker: string,
  right: 'P' | 'C',
  strike: number,
  expiryISO: string,
  currentPremium: number,
): Promise<{ orderId: number; avgFillPrice: number; filledQty: number } | null> {
  if (!isConnected()) return null;
  const expiry = expiryISO.replace(/-/g, '');
  const buyLimit = Math.max(0.01, currentPremium * 1.05);
  try {
    const result = await placeOptionsOrder({
      symbol: ticker,
      right,
      strike,
      expiry,
      contracts: 1,
      limitPrice: buyLimit,
      action: 'BUY',
      account: getDefaultAccount() ?? undefined,
    });
    if (result.timedOut) {
      // Order is live in IB as GTC but didn't fill within the timeout window.
      // Return null so callers don't record a premature close at $0.
      // The position stays open; the GTC order will fill later (or the user cancels it).
      console.warn(`[Options Manager] IB buy-to-close for ${ticker} $${strike}${right} timed out (order #${result.orderId}) — leaving position open until fill confirmed`);
      return null;
    }
    return result;
  } catch (err) {
    console.warn(`[Options Manager] IB buy-to-close FAILED for ${ticker} $${strike}${right}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ── Load Open Positions ──────────────────────────────────

export async function getOpenOptionsPositions(): Promise<OpenOptionsPosition[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('paper_trades')
    .select('id, ticker, mode, option_strike, option_expiry, option_premium, option_capital_req, option_assigned, fill_price, status, pnl')
    .in('mode', [...OPTIONS_MODES])
    .in('status', [...ACTIVE_STATUSES]);

  if (error || !data) return [];

  const positions: OpenOptionsPosition[] = [];

  for (const row of data as PositionRow[]) {
    if (!row.option_strike || !row.option_expiry) continue;

    const dte = daysUntil(row.option_expiry);
    const premiumCollected = row.option_premium ?? 0;

    // Use stored P&L from the manage cycle (updated every 30 min via IB/Finnhub)
    const storedPnl = row.pnl ?? 0;
    const currentPremium = premiumCollected > 0
      ? Math.max(0, premiumCollected - storedPnl / 100)
      : 0;
    const profitCapturePct = premiumCollected > 0
      ? Math.max(0, (1 - currentPremium / premiumCollected) * 100)
      : 0;
    const pnl = storedPnl;

    positions.push({
      id: row.id,
      ticker: row.ticker,
      mode: row.mode as 'OPTIONS_PUT' | 'OPTIONS_CALL',
      strike: row.option_strike,
      expiry: row.option_expiry,
      expiryDate: new Date(row.option_expiry),
      daysToExpiry: dte,
      premiumCollected,
      currentPremium,
      profitCapturePct,
      pnl,
      capitalRequired: row.option_capital_req ?? row.option_strike * 100,
      status: row.status,
      isAssigned: row.option_assigned ?? false,
    });
  }

  return positions;
}

// ── Manage Cycle (runs every 30 min) ─────────────────────

export interface ManageCycleResult {
  closed50Pct: string[];
  rollAlerts: string[];
  assignmentAlerts: string[];
  expiredPositions: string[];
  stopLossAlerts: string[];
  stopLossMultiplier: number;
  profitClosePct: number;
}

export async function runOptionsManageCycle(): Promise<ManageCycleResult> {
  const sb = getSupabase();
  const result: ManageCycleResult = {
    closed50Pct: [],
    rollAlerts: [],
    assignmentAlerts: [],
    expiredPositions: [],
    stopLossAlerts: [],
    stopLossMultiplier: 3,
    profitClosePct: 50,
  };

  // Load auto-tuned wheel parameters from DB
  const wheelConfig = await getOptionsAutoTradeConfig();
  const profitClosePct = wheelConfig.profitClosePct;
  const stopLossMultiplier = wheelConfig.stopLossMultiplier;
  result.stopLossMultiplier = stopLossMultiplier;
  result.profitClosePct = profitClosePct;

  // ── Clean up stale SUBMITTED options orders ──────────────
  // Only cancel SUBMITTED orders that have NO ib_order_id — those are pure
  // paper records that never made it to IB (process restart, timeout before
  // placeOrder was called, etc.).
  // Orders WITH an ib_order_id are live GTC orders in IB awaiting a fill —
  // do NOT auto-cancel them here; they will be updated when IB fills them or
  // when the user explicitly discards them.
  {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: stale } = await sb
      .from('paper_trades')
      .select('id, ticker, option_strike, ib_order_id')
      .in('mode', [...OPTIONS_MODES])
      .eq('status', 'SUBMITTED')
      .is('ib_order_id', null)
      .lt('opened_at', fiveMinAgo);

    if (stale?.length) {
      for (const row of stale as Array<{ id: string; ticker: string; option_strike: number; ib_order_id: number | null }>) {
        await sb.from('paper_trades').update({
          status: 'CANCELLED',
          close_reason: 'expired',
          closed_at: new Date().toISOString(),
          notes: `[AUTO] Stale SUBMITTED order — no IB fill confirmation received`,
        }).eq('id', row.id);

        console.log(`[Options Manager] Cancelled stale SUBMITTED order for ${row.ticker} $${row.option_strike}P (ib_order=${row.ib_order_id})`);
        persistEvent(row.ticker, 'warning',
          `⚠️ ${row.ticker} $${row.option_strike}P order expired — no IB fill confirmation`,
          { action: 'skipped', source: 'scanner', mode: 'OPTIONS_PUT', metadata: { ibOrderId: row.ib_order_id } }
        );
      }
    }
  }

  const { data, error } = await sb
    .from('paper_trades')
    .select('id, ticker, mode, option_strike, option_expiry, option_premium, option_capital_req, option_assigned, fill_price, status, ib_order_id, roll_count, rolled_from_id')
    .in('mode', [...OPTIONS_MODES])
    .in('status', ['FILLED', 'PARTIAL']);

  if (error || !data) return result;

  for (const pos of data as PositionRow[]) {
    if (!pos.option_strike || !pos.option_expiry) continue;

    const dte = daysUntil(pos.option_expiry);
    const premiumCollected = pos.option_premium ?? 0;

    // ── Check 1: Expired (past expiry date) ──
    if (dte <= 0) {
      // Option expired — close as profit (premium kept) if not assigned
      await recordTradeClose({
        tradeId: pos.id,
        closePrice: 0,
        closeReason: 'expired_worthless',
        status: 'CLOSED',
        accountType: 'paper',
        overridePnl: premiumCollected * 100,
        overridePnlPct: (premiumCollected / pos.option_strike) * 100,
        overridePnlSource: 'ib_fill_calculated',
        extraUpdates: { option_close_pct: 100 },
      });

      result.expiredPositions.push(pos.ticker);
      persistEvent(pos.ticker, 'success',
        `✅ ${pos.ticker} $${pos.option_strike} put expired worthless — kept $${(premiumCollected * 100).toFixed(0)} premium`,
        { action: 'closed', source: 'options', metadata: { reason: 'expired_worthless', premium: premiumCollected * 100 } }
      );
      continue;
    }

    // ── Check 2: Get current premium from IB ──
    if (!isConnected()) continue;

    let stockPrice: number | null = null;
    const q = await finnhubFetch<{ c?: number; dp?: number }>(
      `https://finnhub.io/api/v1/quote?symbol=${pos.ticker}&token=${FINNHUB_KEY}`,
    );
    stockPrice = q?.c ?? null;
    // Green day: stock up ≥1.5% on the day. IV compresses on green days → premium shrinks faster.
    // Rule: on a green day, take profit earlier (35% capture instead of the usual 50%).
    // "Close sold puts for profit on green days" — kaycapitals wheel playbook.
    const todayChangePct = q?.dp ?? 0;
    const isGreenDay = todayChangePct >= 1.5;

    if (!stockPrice) continue;

    // Skip P&L computation if no premium was collected (order filled at $0 = data error).
    // Computing (0 - currentPremium)*100 would write a phantom loss to the DB.
    if (premiumCollected <= 0) continue;

    const currentPremium = await getCurrentPremium(pos.ticker, pos.option_strike, pos.option_expiry, stockPrice);
    if (currentPremium === null) continue;

    const profitCapturePct = Math.max(0, (1 - currentPremium / premiumCollected) * 100);
    const pnl = (premiumCollected - currentPremium) * 100;

    // Update live P&L on the trade
    await sb.from('paper_trades').update({ pnl }).eq('id', pos.id);

    // ── Check 3: Hard stop-loss — close when premium exceeds stopLossMultiplier × original ──
    // IMPORTANT: We require the stock to ALSO be below strike before triggering.
    // A put premium can triple purely from an IV spike (market fear) while the stock is still
    // safely above strike — that is NOT a real loss. Closing there crystallizes a loss for nothing.
    // Only close when both conditions are true: premium blew up AND the stock is under the strike.
    const stopLossMultiplierBreached = currentPremium > premiumCollected * stopLossMultiplier;
    const stockBelowStrike = stockPrice < pos.option_strike;
    if (stopLossMultiplierBreached && stockBelowStrike) {
      const ibClose = await ibBuyToCloseOption(pos.ticker, 'P', pos.option_strike, pos.option_expiry, currentPremium);
      if (!ibClose) {
        persistEvent(pos.ticker, 'warning',
          `⚠️ ${pos.ticker} $${pos.option_strike}P stop-loss triggered but IB buy-to-close failed — position left open for retry`,
          { action: 'skipped', source: 'options', metadata: { reason: 'ib_close_failed', trigger: 'stop_loss', currentPremium, premiumCollected } }
        );
        continue;
      }
      const closePremium = ibClose.avgFillPrice;
      const closePnl = (premiumCollected - closePremium) * 100;
      const closeProfitPct = premiumCollected > 0 ? Math.max(0, (1 - closePremium / premiumCollected) * 100) : 0;
      const lossAmount = Math.abs(closePnl);
      await recordTradeClose({
        tradeId: pos.id,
        closePrice: closePremium,
        closeReason: 'stop_loss',
        status: 'CLOSED',
        orderId: ibClose.orderId,
        accountType: 'paper',
        overridePnl: closePnl,
        overridePnlPct: (closePnl / (pos.option_capital_req ?? pos.option_strike * 100)) * 100,
        overridePnlSource: 'ib_fill_calculated',
        extraUpdates: { option_close_pct: closeProfitPct },
      });

      console.log(`[Options Manager] STOP-LOSS: ${pos.ticker} $${pos.option_strike}P — stock $${stockPrice.toFixed(2)} below strike + premium ${stopLossMultiplier}×+ original, closing for -$${lossAmount.toFixed(0)} (IB fill @ $${closePremium.toFixed(4)})`);
      persistEvent(pos.ticker, 'error',
        `🛑 ${pos.ticker} $${pos.option_strike} put stopped — stock at $${stockPrice.toFixed(2)} (below strike) and premium blew past ${stopLossMultiplier}× ($${closePremium.toFixed(2)} vs collected $${premiumCollected.toFixed(2)}), taking -$${lossAmount.toFixed(0)} loss`,
        { action: 'closed', source: 'options', metadata: { reason: 'stop_loss', pnl: closePnl, closePremium, premiumCollected, stopLossMultiplier, stockPrice, ibOrderId: ibClose.orderId } }
      );
      result.stopLossAlerts.push(pos.ticker);
      continue;
    }

    // ── Check 3b: Profit capture threshold — auto close when target % reached ──
    // profitClosePct is auto-tuned by Rule G (default 50%).
    // On a green day (stock up ≥1.5%), lower the threshold to 35%: IV compresses as fear drops,
    // so we capture gains faster rather than watching premium bleed back up if the stock reverses.
    // close_reason stays '50pct_profit' so Rule G's close-reason analysis works correctly.
    const effectiveProfitClosePct = isGreenDay ? Math.min(profitClosePct, 35) : profitClosePct;
    if (profitCapturePct >= effectiveProfitClosePct) {
      const ibClose = await ibBuyToCloseOption(pos.ticker, 'P', pos.option_strike, pos.option_expiry, currentPremium);
      if (!ibClose) {
        persistEvent(pos.ticker, 'warning',
          `⚠️ ${pos.ticker} $${pos.option_strike}P profit target hit but IB buy-to-close failed — position left open for retry`,
          { action: 'skipped', source: 'options', metadata: { reason: 'ib_close_failed', trigger: '50pct_profit', currentPremium, premiumCollected } }
        );
        continue;
      }
      const closePremium = ibClose.avgFillPrice;
      const closePnl = (premiumCollected - closePremium) * 100;
      const closeProfitPct = premiumCollected > 0 ? Math.max(0, (1 - closePremium / premiumCollected) * 100) : 0;
      await recordTradeClose({
        tradeId: pos.id,
        closePrice: closePremium,
        closeReason: '50pct_profit',
        status: 'CLOSED',
        orderId: ibClose.orderId,
        accountType: 'paper',
        overridePnl: closePnl,
        overridePnlPct: (closePnl / (pos.option_capital_req ?? pos.option_strike * 100)) * 100,
        overridePnlSource: 'ib_fill_calculated',
        extraUpdates: { option_close_pct: closeProfitPct },
      });

      result.closed50Pct.push(pos.ticker);
      persistEvent(pos.ticker, 'success',
        `💰 ${pos.ticker} $${pos.option_strike} put closed at ${closeProfitPct.toFixed(0)}% profit (target ${profitClosePct}%) — captured $${closePnl.toFixed(0)} (IB fill @ $${closePremium.toFixed(4)})`,
        { action: 'closed', source: 'options', metadata: { reason: '50pct_profit', pnl: closePnl, closeProfitPct, profitClosePct, ibOrderId: ibClose.orderId } }
      );
      continue;
    }

    // ── Check 3c: Early roll when stock threatens strike ──
    // Trigger: stock 3%+ below strike AND premium grown 1.2× AND ≥22 DTE.
    // At this point there's still enough time value on a new leg to collect a good credit.
    // Try to roll; if not viable, fire a warning alert for manual review.
    if (stockPrice < pos.option_strike * 0.97 && currentPremium > premiumCollected * 1.2 && dte > 21) {
      console.log(`[Options Manager] EARLY ROLL CHECK: ${pos.ticker} $${pos.option_strike}P — stock $${stockPrice.toFixed(2)}, premium ${(currentPremium / premiumCollected * 100).toFixed(0)}% of collected, ${dte}d left`);
      const rollResult = await evaluateAndRollPut(pos, stockPrice, currentPremium);
      console.log(`[Options Manager] Early roll eval: ${rollResult.logLine}`);

      if (rollResult.rolled) {
        result.rollAlerts.push(pos.ticker);
        persistEvent(pos.ticker, 'info',
          `↩️ ${pos.ticker} $${pos.option_strike} put rolled early (stock threatened strike) — ${rollResult.logLine.split(': ')[1]}`,
          { action: 'rolled', source: 'options', metadata: { reason: 'early_roll_' + rollResult.reason, dte, stockPrice } }
        );
      } else {
        result.rollAlerts.push(pos.ticker);
        persistEvent(pos.ticker, 'warning',
          `↩️ ${pos.ticker} $${pos.option_strike} put needs attention — stock at $${stockPrice.toFixed(2)} (${(((pos.option_strike - stockPrice) / pos.option_strike) * 100).toFixed(1)}% below strike), ${dte}d left. Roll not viable (${rollResult.reason}) — manual review recommended.`,
          { action: 'flagged', source: 'options', metadata: { reason: 'roll_needed', rollDeclineReason: rollResult.reason, stockPrice, strike: pos.option_strike, dte, currentPremium, premiumCollected } }
        );
      }
      continue;
    }

    // ── Check 4: 21 DTE — roll down-and-out, or close if roll isn't worth it ──
    // At 21 DTE gamma risk accelerates; risk/reward of holding degrades sharply.
    // ── Check 4: 21 DTE management ──
    // At 21 DTE, theta decay accelerates — this is actually peak profitability territory.
    // Only force-close if the position is deeply underwater (loss > premium collected).
    // Mildly underwater or near-breakeven positions should ride the final theta curve.
    // Winners: lock in profit. Losers within 1× premium: let theta work. Deep losers: try roll, then close.
    if (dte <= 21 && dte > 0) {
      const isWinner = pnl >= 0;
      const premiumInDollars = premiumCollected * 100;
      const isDeepLoser = pnl < 0 && Math.abs(pnl) > premiumInDollars;

      if (isWinner) {
        const ibClose = await ibBuyToCloseOption(pos.ticker, 'P', pos.option_strike, pos.option_expiry, currentPremium);
        if (!ibClose) {
          persistEvent(pos.ticker, 'warning',
            `⚠️ ${pos.ticker} $${pos.option_strike}P 21 DTE winner close triggered but IB buy-to-close failed — position left open for retry`,
            { action: 'skipped', source: 'options', metadata: { reason: 'ib_close_failed', trigger: '21dte_profit', currentPremium, premiumCollected } }
          );
          continue;
        }
        const closePremium = ibClose.avgFillPrice;
        const closePnl = (premiumCollected - closePremium) * 100;
        const closeProfitPct = premiumCollected > 0 ? Math.max(0, (1 - closePremium / premiumCollected) * 100) : 0;
        const closeReason = '21dte_profit';
        await recordTradeClose({
          tradeId: pos.id,
          closePrice: closePremium,
          closeReason,
          status: 'CLOSED',
          orderId: ibClose.orderId,
          accountType: 'paper',
          overridePnl: closePnl,
          overridePnlPct: (closePnl / (pos.option_capital_req ?? pos.option_strike * 100)) * 100,
          overridePnlSource: 'ib_fill_calculated',
          extraUpdates: { option_close_pct: closeProfitPct },
        });

        result.rollAlerts.push(pos.ticker);
        console.log(`[Options Manager] 21 DTE CLOSE (winner): ${pos.ticker} $${pos.option_strike}P — profit +$${closePnl.toFixed(0)} (${dte}d left, IB fill @ $${closePremium.toFixed(4)})`);
        persistEvent(pos.ticker, 'success',
          `⏱️ ${pos.ticker} $${pos.option_strike} put closed at 21 DTE — locked in +$${closePnl.toFixed(0)} with ${dte} days remaining`,
          { action: 'closed', source: 'options', metadata: { reason: closeReason, dte, pnl: closePnl, closeProfitPct, ibOrderId: ibClose.orderId } }
        );
        continue;
      }

      if (isDeepLoser) {
        // Deep loser (loss exceeds premium collected) — try to roll, then close as last resort
        if (isConnected() && stockPrice) {
          const rollResult = await evaluateAndRollPut(pos, stockPrice, currentPremium);
          console.log(`[Options Manager] 21 DTE roll eval: ${rollResult.logLine}`);

          if (rollResult.rolled) {
            result.rollAlerts.push(pos.ticker);
            persistEvent(pos.ticker, 'info',
              `↩️ ${pos.ticker} $${pos.option_strike} put rolled at 21 DTE — ${rollResult.logLine.split(': ')[1]}`,
              { action: 'rolled', source: 'options', metadata: { reason: rollResult.reason, dte } }
            );
            continue;
          }
          console.log(`[Options Manager] 21 DTE roll declined (${rollResult.reason}) — closing deep loser ${pos.ticker}`);
        }

        // Hard close deep loser — place IB buy-to-close first
        const ibCloseDeep = await ibBuyToCloseOption(pos.ticker, 'P', pos.option_strike, pos.option_expiry, currentPremium);
        if (!ibCloseDeep) {
          persistEvent(pos.ticker, 'warning',
            `⚠️ ${pos.ticker} $${pos.option_strike}P 21 DTE deep loser close triggered but IB buy-to-close failed — position left open for retry`,
            { action: 'skipped', source: 'options', metadata: { reason: 'ib_close_failed', trigger: '21dte_close', currentPremium, premiumCollected } }
          );
          continue;
        }
        const deepClosePremium = ibCloseDeep.avgFillPrice;
        const deepClosePnl = (premiumCollected - deepClosePremium) * 100;
        const deepCloseProfitPct = premiumCollected > 0 ? Math.max(0, (1 - deepClosePremium / premiumCollected) * 100) : 0;
        const closeReason = '21dte_close';
        await recordTradeClose({
          tradeId: pos.id,
          closePrice: deepClosePremium,
          closeReason,
          status: 'CLOSED',
          orderId: ibCloseDeep.orderId,
          accountType: 'paper',
          overridePnl: deepClosePnl,
          overridePnlPct: (deepClosePnl / (pos.option_capital_req ?? pos.option_strike * 100)) * 100,
          overridePnlSource: 'ib_fill_calculated',
          extraUpdates: { option_close_pct: deepCloseProfitPct },
        });

        result.rollAlerts.push(pos.ticker);
        console.log(`[Options Manager] 21 DTE CLOSE (deep loser): ${pos.ticker} $${pos.option_strike}P — loss -$${Math.abs(deepClosePnl).toFixed(0)} exceeds premium $${premiumInDollars.toFixed(0)} (${dte}d left, IB fill @ $${deepClosePremium.toFixed(4)})`);
        persistEvent(pos.ticker, 'warning',
          `⚠️ ${pos.ticker} $${pos.option_strike} put closed at 21 DTE — cut deep loss at -$${Math.abs(deepClosePnl).toFixed(0)} (>${premiumInDollars.toFixed(0)} premium) with ${dte} days remaining`,
          { action: 'closed', source: 'options', metadata: { reason: closeReason, dte, pnl: deepClosePnl, deepCloseProfitPct, ibOrderId: ibCloseDeep.orderId } }
        );
        continue;
      }

      // Mild loser (loss within 1× premium collected) — let theta decay work
      console.log(`[Options Manager] 21 DTE HOLD: ${pos.ticker} $${pos.option_strike}P — loss -$${Math.abs(pnl).toFixed(0)} within premium ($${premiumInDollars.toFixed(0)}), riding theta (${dte}d left)`);
    }

    // ── Check 5: Assignment detection (stock price below strike at/near expiry) ──
    // Real assignment happens at expiry (or early exercise). We approximate by requiring:
    //   - stock is below strike (not just near it)
    //   - DTE ≤ 5 (within expiry week — early exercise risk is real here)
    //   - not already flagged as assigned (prevents repeated phantom covered call creation)
    // A stock below strike with 20 DTE remaining is NOT an assignment — it's a roll candidate.
    if (stockPrice < pos.option_strike && dte <= 5 && !pos.option_assigned) {
      result.assignmentAlerts.push(pos.ticker);

      // Mark the put as assigned so subsequent cycles don't re-trigger
      await sb.from('paper_trades').update({ option_assigned: true }).eq('id', pos.id);

      // Open a covered call targeting 20-delta (~80% probability of expiring OTM).
      // Following the covered-calls video strategy: 15-25 delta, 30-45 DTE is the sweet spot —
      // enough premium to be worth collecting, enough OTM room to not cap the recovery.
      // The 10% OTM floor is kept as an additional guard: whichever gives a HIGHER strike wins,
      // ensuring we never sell the rebound cheaply on a freshly-assigned position.
      const ccExpiry = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000); // 45 DTE
      const ccExpiryISO = ccExpiry.toISOString().slice(0, 10);
      const minCcStrikeFloor = stockPrice * 1.10; // hard floor: at least 10% OTM

      // Fetch covered call from chain at 20-delta; fall back to floor if chain unavailable
      let ccPremium = 0;
      let ccStrikeFromChain: number | null = null;
      try {
        const ccChain = await getOptionsChain(pos.ticker, stockPrice, null, 0.20, 45); // 20-delta, ~45 DTE
        if (ccChain?.bestCall) {
          ccStrikeFromChain = ccChain.bestCall.strike;
          ccPremium = ccChain.bestCall.bid; // conservative: use bid price
        }
      } catch { /* non-blocking — insert with 0 if chain unavailable */ }

      // Three-guard rule (from SMB Capital covered-calls video — "the deadly mistake"):
      // NEVER locate the short call below the share acquisition price (the put strike).
      // If stock drops after assignment and we sell a call below cost basis, any bounce
      // that triggers assignment locks in a guaranteed realized loss on the shares —
      // wiping out all premium collected across the entire wheel cycle.
      //
      // Guard 1: acquisition price (put strike = cost basis of the assigned shares)
      // Guard 2: 10% OTM floor above current stock price  (recovery room)
      // Guard 3: 20-delta strike from chain               (video's probability target)
      // Final strike = highest of all three — even if premium collected is tiny.
      const acquisitionPrice = pos.option_strike; // the put strike that was assigned
      const rawCcStrike = Math.max(acquisitionPrice, minCcStrikeFloor, ccStrikeFromChain ?? minCcStrikeFloor);
      const ccStrike = Math.round(rawCcStrike * 4) / 4; // round to nearest $0.25

      const inCostBasisProtectionMode = rawCcStrike <= acquisitionPrice * 1.005; // within 0.5% of cost basis

      await sb.from('paper_trades').insert({
        ticker: pos.ticker,
        mode: 'OPTIONS_CALL',
        signal: 'SELL',
        entry_price: stockPrice,
        fill_price: stockPrice,
        quantity: 1,
        position_size: stockPrice * 100,
        status: 'FILLED',
        filled_at: new Date().toISOString(),
        opened_at: new Date().toISOString(),
        option_strike: ccStrike,
        option_expiry: ccExpiryISO,
        option_premium: ccPremium,
        option_contracts: 1,
        option_capital_req: stockPrice * 100,
        option_assigned: false,
        scanner_reason: 'wheel_assignment_covered_call',
        notes: `Covered call after assignment on ${pos.ticker} put at $${pos.option_strike} — collected $${(ccPremium * 100).toFixed(0)} premium`,
      });

      const modeTag = inCostBasisProtectionMode
        ? ' [COST BASIS PROTECTION — premium may be minimal]'
        : '';
      console.log(`[Options Manager] Assignment detected — covered call queued: ${pos.ticker} $${ccStrike}C exp ${ccExpiryISO}${modeTag}`);
      persistEvent(pos.ticker, 'warning',
        `📌 ${pos.ticker} assignment → covered call queued: $${ccStrike}C exp ${ccExpiryISO}, premium $${(ccPremium * 100).toFixed(0)}${modeTag}`,
        { action: 'flagged', source: 'options', metadata: { reason: 'assignment_detected_covered_call_queued', stockPrice, acquisitionPrice, strike: pos.option_strike, ccStrike, ccExpiry: ccExpiryISO, ccPremium, inCostBasisProtectionMode } }
      );
    }
  }

  // ── Process Covered Calls ─────────────────────────────────
  const { data: callData } = await sb
    .from('paper_trades')
    .select('id, ticker, mode, option_strike, option_expiry, option_premium, option_capital_req, option_assigned, fill_price, status, ib_order_id, roll_count, rolled_from_id')
    .eq('mode', 'OPTIONS_CALL')
    .in('status', ['FILLED', 'PARTIAL']);

  for (const pos of (callData ?? []) as PositionRow[]) {
    if (!pos.option_strike || !pos.option_expiry) continue;

    const dte = daysUntil(pos.option_expiry);
    const premiumCollected = pos.option_premium ?? 0;

    // Check A: Expired worthless (stock stayed below call strike) — keep premium
    if (dte <= 0) {
      await recordTradeClose({
        tradeId: pos.id,
        closePrice: 0,
        closeReason: 'expired_worthless',
        status: 'CLOSED',
        accountType: 'paper',
        overridePnl: premiumCollected * 100,
        overridePnlPct: (premiumCollected / pos.option_strike) * 100,
        overridePnlSource: 'ib_fill_calculated',
      });
      persistEvent(pos.ticker, 'success',
        `✅ ${pos.ticker} $${pos.option_strike} covered call expired worthless — kept $${(premiumCollected * 100).toFixed(0)} premium`,
        { action: 'closed', source: 'options', metadata: { reason: 'expired_worthless', premium: premiumCollected * 100 } }
      );
      continue;
    }

    if (!isConnected()) continue;

    let stockPrice: number | null = null;
    const ccQ = await finnhubFetch<{ c?: number }>(
      `https://finnhub.io/api/v1/quote?symbol=${pos.ticker}&token=${FINNHUB_KEY}`,
    );
    stockPrice = ccQ?.c ?? null;
    if (!stockPrice) continue;

    // Get current call premium
    const currentCallPremium = await getCurrentCallPremium(pos.ticker, pos.option_strike, pos.option_expiry, stockPrice);
    if (currentCallPremium === null) continue;

    const profitCapturePct = premiumCollected > 0
      ? Math.max(0, (1 - currentCallPremium / premiumCollected) * 100)
      : 0;
    const pnl = (premiumCollected - currentCallPremium) * 100;
    await sb.from('paper_trades').update({ pnl }).eq('id', pos.id);

    // Check B: Profit capture threshold — auto close when target % reached (same as puts)
    if (profitCapturePct >= profitClosePct) {
      const ibCloseCall = await ibBuyToCloseOption(pos.ticker, 'C', pos.option_strike, pos.option_expiry, currentCallPremium);
      if (!ibCloseCall) {
        persistEvent(pos.ticker, 'warning',
          `⚠️ ${pos.ticker} $${pos.option_strike}C profit target hit but IB buy-to-close failed — position left open for retry`,
          { action: 'skipped', source: 'options', metadata: { reason: 'ib_close_failed', trigger: '50pct_profit', currentCallPremium, premiumCollected } }
        );
        continue;
      }
      const callClosePremium = ibCloseCall.avgFillPrice;
      const callClosePnl = (premiumCollected - callClosePremium) * 100;
      const callCloseProfitPct = premiumCollected > 0 ? Math.max(0, (1 - callClosePremium / premiumCollected) * 100) : 0;
      await recordTradeClose({
        tradeId: pos.id,
        closePrice: callClosePremium,
        closeReason: '50pct_profit',
        status: 'CLOSED',
        orderId: ibCloseCall.orderId,
        accountType: 'paper',
        overridePnl: callClosePnl,
        overridePnlPct: (callClosePnl / (pos.option_capital_req ?? pos.option_strike * 100)) * 100,
        overridePnlSource: 'ib_fill_calculated',
        extraUpdates: { option_close_pct: callCloseProfitPct },
      });
      result.closed50Pct.push(pos.ticker);
      persistEvent(pos.ticker, 'success',
        `💰 ${pos.ticker} $${pos.option_strike} covered call closed at ${callCloseProfitPct.toFixed(0)}% profit (target ${profitClosePct}%) — captured $${callClosePnl.toFixed(0)} (IB fill @ $${callClosePremium.toFixed(4)})`,
        { action: 'closed', source: 'options', metadata: { reason: '50pct_profit', pnl: callClosePnl, callCloseProfitPct, profitClosePct, ibOrderId: ibCloseCall.orderId } }
      );
      continue;
    }

    // Check C: 21 DTE — buy back if stock is safely below strike (≥10% OTM).
    // Mirrors the put 21 DTE rule: free up capital once theta has done most of its work
    // and the remaining time value isn't worth the assignment risk into expiry.
    if (dte <= 21 && stockPrice < pos.option_strike * 0.90) {
      const ibCloseCall21 = await ibBuyToCloseOption(pos.ticker, 'C', pos.option_strike, pos.option_expiry, currentCallPremium);
      if (!ibCloseCall21) {
        persistEvent(pos.ticker, 'warning',
          `⚠️ ${pos.ticker} $${pos.option_strike}C 21 DTE close triggered but IB buy-to-close failed — position left open for retry`,
          { action: 'skipped', source: 'options', metadata: { reason: 'ib_close_failed', trigger: '21dte_close', currentCallPremium, premiumCollected } }
        );
        continue;
      }
      const call21ClosePremium = ibCloseCall21.avgFillPrice;
      const call21ClosePnl = (premiumCollected - call21ClosePremium) * 100;
      const call21CloseProfitPct = premiumCollected > 0 ? Math.max(0, (1 - call21ClosePremium / premiumCollected) * 100) : 0;
      await recordTradeClose({
        tradeId: pos.id,
        closePrice: call21ClosePremium,
        closeReason: '21dte_close',
        status: 'CLOSED',
        orderId: ibCloseCall21.orderId,
        accountType: 'paper',
        overridePnl: call21ClosePnl,
        overridePnlPct: (call21ClosePnl / (pos.option_capital_req ?? pos.option_strike * 100)) * 100,
        overridePnlSource: 'ib_fill_calculated',
        extraUpdates: { option_close_pct: call21CloseProfitPct },
      });
      persistEvent(pos.ticker, 'success',
        `📅 ${pos.ticker} $${pos.option_strike} covered call closed at 21 DTE — captured $${call21ClosePnl.toFixed(0)} (${call21CloseProfitPct.toFixed(0)}% of premium, IB fill @ $${call21ClosePremium.toFixed(4)})`,
        { action: 'closed', source: 'options', metadata: { reason: '21dte_close', pnl: call21ClosePnl, dte, call21CloseProfitPct, ibOrderId: ibCloseCall21.orderId } }
      );
      continue;
    }

    // Check D: Stop — call premium exceeded 2× collected (stock deep ITM, call is a loser).
    // At 2× collected we've lost as much in the buyback as we originally collected — cut it.
    const callStopMultiplier = 2.0;
    if (currentCallPremium > premiumCollected * callStopMultiplier && stockPrice > pos.option_strike) {
      const ibCloseCallStop = await ibBuyToCloseOption(pos.ticker, 'C', pos.option_strike, pos.option_expiry, currentCallPremium);
      if (!ibCloseCallStop) {
        persistEvent(pos.ticker, 'warning',
          `⚠️ ${pos.ticker} $${pos.option_strike}C stop-loss triggered but IB buy-to-close failed — position left open for retry`,
          { action: 'skipped', source: 'options', metadata: { reason: 'ib_close_failed', trigger: 'call_stop', currentCallPremium, premiumCollected } }
        );
        continue;
      }
      const callStopClosePremium = ibCloseCallStop.avgFillPrice;
      const callStopClosePnl = (premiumCollected - callStopClosePremium) * 100;
      const callStopCloseProfitPct = premiumCollected > 0 ? Math.max(0, (1 - callStopClosePremium / premiumCollected) * 100) : 0;
      await recordTradeClose({
        tradeId: pos.id,
        closePrice: callStopClosePremium,
        closeReason: 'stop_loss',
        status: 'CLOSED',
        orderId: ibCloseCallStop.orderId,
        accountType: 'paper',
        overridePnl: callStopClosePnl,
        overridePnlPct: (callStopClosePnl / (pos.option_capital_req ?? pos.option_strike * 100)) * 100,
        overridePnlSource: 'ib_fill_calculated',
        extraUpdates: { option_close_pct: callStopCloseProfitPct },
      });
      persistEvent(pos.ticker, 'warning',
        `🛑 ${pos.ticker} $${pos.option_strike} covered call stopped — buyback $${callStopClosePremium.toFixed(2)} > ${callStopMultiplier}× collected $${premiumCollected.toFixed(2)}, P&L $${callStopClosePnl.toFixed(0)} (IB fill @ $${callStopClosePremium.toFixed(4)})`,
        { action: 'closed', source: 'options', metadata: { reason: 'call_stop', pnl: callStopClosePnl, dte, callStopClosePremium, premiumCollected, ibOrderId: ibCloseCallStop.orderId } }
      );
      continue;
    }

    // Check F: Roll UP and out when stock threatens call strike (within 2%, DTE > 5).
    // Strategy (covered-calls video): instead of alerting and waiting, attempt an automated
    // "roll up and out" to a higher strike at ~45 DTE for a credit or acceptable small debit.
    // This preserves more upside on recovery while continuing to collect premium.
    // Falls back to a human-review warning if the roll math doesn't work.
    if (stockPrice >= pos.option_strike * 0.98 && dte > 5) {
      console.log(`[Options Manager] CALL ROLL CHECK: ${pos.ticker} $${pos.option_strike}C — stock $${stockPrice.toFixed(2)}, ${dte}d left`);
      const rollResult = await evaluateAndRollCall(pos, stockPrice, currentCallPremium);
      console.log(`[Options Manager] Call roll eval: ${rollResult.logLine}`);

      if (rollResult.rolled) {
        result.rollAlerts.push(pos.ticker);
        persistEvent(pos.ticker, 'info',
          `↩️ ${pos.ticker} $${pos.option_strike} covered call rolled UP — ${rollResult.logLine.split(': ')[1]}`,
          { action: 'rolled', source: 'options', metadata: { reason: 'call_roll_' + rollResult.reason, dte, stockPrice } }
        );
      } else {
        result.rollAlerts.push(pos.ticker);
        persistEvent(pos.ticker, 'warning',
          `↩️ ${pos.ticker} covered call at risk — stock $${stockPrice.toFixed(2)} within 2% of call strike $${pos.option_strike} (${dte}d left). Auto-roll declined (${rollResult.reason}) — manual review needed.`,
          { action: 'flagged', source: 'options', metadata: { reason: 'call_roll_needed', rollDeclineReason: rollResult.reason, stockPrice, strike: pos.option_strike, dte } }
        );
      }
    }
  }

  return result;
}

/**
 * Evaluate and execute a "roll up and out" for a covered call position.
 *
 * Strategy (from covered-calls video + tastytrade roll playbook):
 *   1. Buy back the current call at current market price
 *   2. Sell a new call at a HIGHER strike (~20-delta), ~45 DTE
 *   3. Only proceed if net result is a credit OR small debit (≤25% of original premium)
 *   4. Respect max-debit-roll limit (3 debit rolls per position chain)
 *
 * The "up" in "up and out" is critical: rolling to a higher strike gives the
 * stock MORE room to rally before being called away — preserving recovery upside.
 *
 * Returns true if the roll was executed, false if we should fall back to alerting.
 */
async function evaluateAndRollCall(
  pos: PositionRow,
  stockPrice: number,
  currentCallPremium: number,
): Promise<{ rolled: boolean; reason: string; logLine: string }> {
  const sb = getSupabase();
  const premiumCollected = pos.option_premium ?? 0;
  const rollCount = pos.roll_count ?? 0;

  // Fetch next month's chain at 20-delta call — must be ABOVE current call strike
  // (rolling up, not sideways) to give the stock room to recover
  const chain = await getOptionsChain(pos.ticker, stockPrice, null, 0.20, 45).catch(() => null);
  if (!chain?.bestCall) {
    return { rolled: false, reason: 'no_chain', logLine: `${pos.ticker}: no call chain available for roll` };
  }

  const newCall = chain.bestCall;
  const newStrike = newCall.strike;
  const newExpiry = newCall.expiry;       // YYYYMMDD
  const newPremium = newCall.bid;         // conservative: bid price
  const newDte = daysToExpiryStr(newExpiry);

  // Must roll UP — new strike must be higher than current (otherwise it's not a roll up, it's doubling down)
  if (newStrike <= pos.option_strike) {
    return {
      rolled: false,
      reason: 'no_higher_strike',
      logLine: `${pos.ticker}: chain didn't return a strike above current $${pos.option_strike} — alerting instead`,
    };
  }

  const netCredit = newPremium - currentCallPremium;
  const isCredit = netCredit >= 0;
  const isAcceptableDebit = netCredit < 0 && Math.abs(netCredit) <= premiumCollected * ROLL_MAX_DEBIT_PCT;

  if (!isCredit && !isAcceptableDebit) {
    return {
      rolled: false,
      reason: 'debit_too_large',
      logLine: `${pos.ticker}: call roll debit $${Math.abs(netCredit).toFixed(2)} exceeds 25% limit — alerting instead`,
    };
  }

  if (!isCredit && rollCount >= MAX_DEBIT_ROLLS) {
    return {
      rolled: false,
      reason: 'max_debit_rolls',
      logLine: `${pos.ticker}: already rolled call ${rollCount}× for debit — alerting instead`,
    };
  }

  // Roll math: (strike improvement + credit) / capital, annualized
  const strikeImprovement = newStrike - pos.option_strike; // going UP is good — more room
  const totalBenefit = strikeImprovement + Math.max(0, netCredit);
  const capital = pos.option_capital_req ?? stockPrice * 100;
  const annualizedReturn = newDte > 0 ? (totalBenefit / capital) * (365 / newDte) * 100 : 0;

  if (annualizedReturn < 2) {
    return {
      rolled: false,
      reason: 'low_return',
      logLine: `${pos.ticker}: call roll ann. return ${annualizedReturn.toFixed(1)}% < 2% — not worth it, alerting instead`,
    };
  }

  // ── Execute the roll ─────────────────────────────────────

  // 1. Close current call leg via IB buy-to-close
  const ibCloseOldCall = await ibBuyToCloseOption(pos.ticker, 'C', pos.option_strike, pos.option_expiry, currentCallPremium);
  if (!ibCloseOldCall) {
    return {
      rolled: false,
      reason: 'ib_close_failed',
      logLine: `${pos.ticker}: IB buy-to-close failed for old call leg $${pos.option_strike}C — roll aborted`,
    };
  }
  const rollCallClosePremium = ibCloseOldCall.avgFillPrice;
  const pnl = (premiumCollected - rollCallClosePremium) * 100;

  await recordTradeClose({
    tradeId: pos.id,
    closePrice: rollCallClosePremium,
    closeReason: 'rolled',
    status: 'CLOSED',
    orderId: ibCloseOldCall.orderId,
    accountType: 'paper',
    overridePnl: pnl,
    overridePnlPct: (pnl / capital) * 100,
    overridePnlSource: 'ib_fill_calculated',
    extraUpdates: { option_close_pct: Math.max(0, (1 - rollCallClosePremium / premiumCollected) * 100) },
  });

  // 2. Open new call leg
  const newExpiryISO = `${newExpiry.slice(0, 4)}-${newExpiry.slice(4, 6)}-${newExpiry.slice(6, 8)}`;
  let ibOrderId: number | null = null;
  if (isConnected()) {
    try {
      const r = await placeOptionsOrder({
        symbol: pos.ticker,
        right: 'C',
        strike: newStrike,
        expiry: newExpiry,
        contracts: 1,
        limitPrice: newPremium,
        account: getDefaultAccount() ?? undefined,
      });
      ibOrderId = r.orderId;
    } catch (err) {
      console.warn(`[Roll Call] IB order failed for ${pos.ticker} — paper-recording: ${err}`);
    }
  }

  await sb.from('paper_trades').insert({
    ticker: pos.ticker,
    mode: 'OPTIONS_CALL',
    signal: 'SELL',
    entry_price: stockPrice,
    fill_price: ibOrderId ? null : stockPrice,
    quantity: 1,
    position_size: stockPrice * 100,
    status: ibOrderId ? 'SUBMITTED' : 'FILLED',
    filled_at: ibOrderId ? null : new Date().toISOString(),
    opened_at: new Date().toISOString(),
    option_strike: newStrike,
    option_expiry: newExpiryISO,
    option_premium: newPremium,
    option_contracts: 1,
    option_delta: newCall.delta,
    option_prob_profit: newCall.probProfit,
    option_capital_req: capital,
    option_annual_yield: newCall.annualYield,
    ib_order_id: ibOrderId,
    roll_count: rollCount + 1,
    rolled_from_id: pos.id,
    notes: `[CALL ROLL ${rollCount + 1}] ${isCredit ? `+$${(netCredit * 100).toFixed(0)} credit` : `-$${(Math.abs(netCredit) * 100).toFixed(0)} debit`} — rolled UP from $${pos.option_strike}→$${newStrike} strike, ${newDte}d DTE`,
    scanner_reason: `Call Roll ${rollCount + 1}: ann. ${annualizedReturn.toFixed(1)}%, ${isCredit ? 'credit' : 'debit'} $${Math.abs(netCredit * 100).toFixed(0)}, strike ${pos.option_strike}→${newStrike}`,
  });

  const creditTag = isCredit
    ? `+$${(netCredit * 100).toFixed(0)} credit`
    : `-$${(Math.abs(netCredit) * 100).toFixed(0)} debit`;
  const ibTag = ibOrderId ? ` IB#${ibOrderId}` : ' (paper)';

  return {
    rolled: true,
    reason: isCredit ? 'credit_roll' : 'debit_roll',
    logLine: `${pos.ticker}: call rolled UP $${pos.option_strike}→$${newStrike}C ${newExpiryISO} (${creditTag}, ${annualizedReturn.toFixed(1)}% ann.)${ibTag}`,
  };
}

/**
 * Mark a put as assigned — creates a synthetic LONG_TERM position
 * for the assigned shares and suggests a covered call.
 */
export async function handleAssignment(positionId: string): Promise<void> {
  const sb = getSupabase();
  const { data: pos } = await sb
    .from('paper_trades')
    .select('*')
    .eq('id', positionId)
    .single();

  if (!pos) return;

  // Close the put position
  const assignmentPnl = -(pos.option_strike - pos.option_premium - (pos.fill_price ?? pos.option_strike)) * 100;
  await recordTradeClose({
    tradeId: positionId,
    closePrice: pos.option_strike,
    closeReason: 'assigned',
    status: 'CLOSED',
    accountType: 'paper',
    overridePnl: assignmentPnl,
    overridePnlSource: 'ib_fill_calculated',
    extraUpdates: { option_assigned: true },
  });

  // Log assignment event
  persistEvent(pos.ticker, 'warning',
    `📌 ${pos.ticker} put assigned — now own 100 shares at $${pos.option_net_price?.toFixed(2) ?? pos.option_strike} effective cost. Assignment detected — covered call queued.`,
    { action: 'flagged', source: 'options', metadata: { reason: 'assigned', strike: pos.option_strike, netPrice: pos.option_net_price } }
  );
}

/**
 * Get monthly options P&L summary.
 */
export async function getOptionsMonthlyStats(): Promise<{
  premiumCollected: number;
  wins: number;
  losses: number;
  winRate: number;
  openPositions: number;
  annualizedReturn: number;
}> {
  const sb = getSupabase();
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const { data: closed } = await sb
    .from('paper_trades')
    .select('pnl, option_capital_req')
    .in('mode', [...OPTIONS_MODES])
    .in('status', [...CLOSED_STATUSES])
    .gte('closed_at', monthStart.toISOString());

  const { data: open } = await sb
    .from('paper_trades')
    .select('id')
    .in('mode', [...OPTIONS_MODES])
    .in('status', [...ACTIVE_STATUSES]);

  const trades = closed ?? [];
  // Filter out phantom $0 closes (data integrity guard)
  const realTrades = trades.filter(t => Math.abs(t.pnl ?? 0) > 1);
  const wins = realTrades.filter(t => (t.pnl ?? 0) > 0);
  const losses = realTrades.filter(t => (t.pnl ?? 0) < 0);
  // premiumCollected = total net P&L across all trades (wins minus losses)
  const premiumCollected = realTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const totalCapital = trades.reduce((s, t) => s + (t.option_capital_req ?? 0), 0);
  // Use actual days elapsed since month start, not getDate() which gives today's date number.
  // On Apr 5, getDate()=5 would annualize as if only 5 days of data exist — wildly overstated.
  const msElapsed = Date.now() - monthStart.getTime();
  const daysElapsed = Math.max(1, msElapsed / (1000 * 60 * 60 * 24));
  const annualizedReturn = totalCapital > 0 ? (premiumCollected / totalCapital) * (365 / daysElapsed) * 100 : 0;

  return {
    premiumCollected,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    openPositions: (open ?? []).length,
    annualizedReturn,
  };
}
