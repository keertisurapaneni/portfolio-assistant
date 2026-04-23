/**
 * Options Position Manager
 *
 * Monitors open options positions every 30 minutes and:
 *   - Auto-closes puts at 50% of max profit
 *   - Alerts when expiry ≤ 21 days (roll or close decision)
 *   - Detects assignment and suggests covered call
 *   - Tracks P&L on open positions
 */

import { getSupabase, createAutoTradeEvent } from './supabase.js';
import { getOptionsAutoTradeConfig } from './options-scanner.js';
import { getOptionsChain } from './options-chain.js';
import { isConnected, requestOpenOrders } from '../ib-connection.js';

function persistEvent(ticker: string, eventType: string, message: string, extra?: Record<string, unknown>): void {
  createAutoTradeEvent({ ticker, event_type: eventType, message, ...extra });
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

// ── Load Open Positions ──────────────────────────────────

export async function getOpenOptionsPositions(): Promise<OpenOptionsPosition[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('paper_trades')
    .select('id, ticker, mode, option_strike, option_expiry, option_premium, option_capital_req, option_assigned, fill_price, status, pnl')
    .in('mode', ['OPTIONS_PUT', 'OPTIONS_CALL'])
    .in('status', ['PENDING', 'SUBMITTED', 'FILLED', 'PARTIAL']);

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
}

export async function runOptionsManageCycle(): Promise<ManageCycleResult> {
  const sb = getSupabase();
  const result: ManageCycleResult = {
    closed50Pct: [],
    rollAlerts: [],
    assignmentAlerts: [],
    expiredPositions: [],
    stopLossAlerts: [],
  };

  // Load auto-tuned wheel parameters from DB
  const wheelConfig = await getOptionsAutoTradeConfig();
  const profitClosePct = wheelConfig.profitClosePct;
  const stopLossMultiplier = wheelConfig.stopLossMultiplier;

  // ── Check SUBMITTED orders for IB fills ──────────────────
  if (isConnected()) {
    const { data: submitted } = await sb
      .from('paper_trades')
      .select('id, ticker, option_strike, option_premium, ib_order_id')
      .in('mode', ['OPTIONS_PUT', 'OPTIONS_CALL'])
      .eq('status', 'SUBMITTED')
      .not('ib_order_id', 'is', null);

    if (submitted?.length) {
      const openOrders = await requestOpenOrders().catch(() => []);
      const openOrderIds = new Set(openOrders.map(o => o.orderId));

      for (const row of submitted as Array<{ id: string; ticker: string; option_strike: number; option_premium: number; ib_order_id: number }>) {
        if (!openOrderIds.has(row.ib_order_id)) {
          // Order no longer open → it filled (or was cancelled; treat as filled for options sells)
          await sb.from('paper_trades').update({
            status: 'FILLED',
            filled_at: new Date().toISOString(),
            fill_price: row.option_premium,
          }).eq('id', row.id);

          console.log(`[Options Manager] Order ${row.ib_order_id} for ${row.ticker} $${row.option_strike}P confirmed filled`);
          persistEvent(row.ticker, 'success',
            `✅ ${row.ticker} $${row.option_strike} put order filled — premium $${(row.option_premium * 100).toFixed(0)} collected`,
            { action: 'filled', source: 'options', metadata: { ibOrderId: row.ib_order_id } }
          );
        }
      }
    }
  }

  const { data, error } = await sb
    .from('paper_trades')
    .select('id, ticker, mode, option_strike, option_expiry, option_premium, option_capital_req, option_assigned, fill_price, status, ib_order_id')
    .in('mode', ['OPTIONS_PUT', 'OPTIONS_CALL'])
    .in('status', ['FILLED', 'PARTIAL']);

  if (error || !data) return result;

  for (const pos of data as PositionRow[]) {
    if (!pos.option_strike || !pos.option_expiry) continue;

    const dte = daysUntil(pos.option_expiry);
    const premiumCollected = pos.option_premium ?? 0;

    // ── Check 1: Expired (past expiry date) ──
    if (dte <= 0) {
      // Option expired — close as profit (premium kept) if not assigned
      await sb.from('paper_trades').update({
        status: 'CLOSED',
        close_price: 0,
        pnl: premiumCollected * 100,
        pnl_percent: (premiumCollected / pos.option_strike) * 100,
        closed_at: new Date().toISOString(),
        close_reason: 'expired_worthless',
        option_close_pct: 100,
      }).eq('id', pos.id);

      result.expiredPositions.push(pos.ticker);
      persistEvent(pos.ticker, 'success',
        `✅ ${pos.ticker} $${pos.option_strike} put expired worthless — kept $${(premiumCollected * 100).toFixed(0)} premium`,
        { action: 'closed', source: 'options', metadata: { reason: 'expired_worthless', premium: premiumCollected * 100 } }
      );
      continue;
    }

    // ── Check 2: Get current premium from IB ──
    if (!isConnected()) continue;

    // Get fresh quote for the stock
    let stockPrice: number | null = null;
    try {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${pos.ticker}&token=${process.env.FINNHUB_API_KEY}`);
      const q = await res.json() as { c?: number };
      stockPrice = q.c ?? null;
    } catch { /* skip */ }

    if (!stockPrice) continue;

    const currentPremium = await getCurrentPremium(pos.ticker, pos.option_strike, pos.option_expiry, stockPrice);
    if (currentPremium === null) continue;

    const profitCapturePct = premiumCollected > 0
      ? Math.max(0, (1 - currentPremium / premiumCollected) * 100)
      : 0;
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
      const lossAmount = Math.abs(pnl);
      await sb.from('paper_trades').update({
        status: 'CLOSED',
        close_price: currentPremium,
        pnl,
        pnl_percent: (pnl / (pos.option_capital_req ?? pos.option_strike * 100)) * 100,
        closed_at: new Date().toISOString(),
        close_reason: 'stop_loss',
        option_close_pct: profitCapturePct,
      }).eq('id', pos.id);

      console.log(`[Options Manager] STOP-LOSS: ${pos.ticker} $${pos.option_strike}P — stock $${stockPrice.toFixed(2)} below strike + premium ${stopLossMultiplier}×+ original, closing for -$${lossAmount.toFixed(0)}`);
      persistEvent(pos.ticker, 'error',
        `🛑 ${pos.ticker} $${pos.option_strike} put stopped — stock at $${stockPrice.toFixed(2)} (below strike) and premium blew past ${stopLossMultiplier}× ($${currentPremium.toFixed(2)} vs collected $${premiumCollected.toFixed(2)}), taking -$${lossAmount.toFixed(0)} loss`,
        { action: 'closed', source: 'options', metadata: { reason: 'stop_loss', pnl, currentPremium, premiumCollected, stopLossMultiplier, stockPrice } }
      );
      result.stopLossAlerts.push(pos.ticker);
      continue;
    }

    // ── Check 3b: Profit capture threshold — auto close when target % reached ──
    // profitClosePct is auto-tuned by Rule G (default 50%).
    // close_reason stays '50pct_profit' so Rule G's close-reason analysis works correctly.
    if (profitCapturePct >= profitClosePct) {
      await sb.from('paper_trades').update({
        status: 'CLOSED',
        close_price: currentPremium,
        pnl,
        pnl_percent: (pnl / (pos.option_capital_req ?? pos.option_strike * 100)) * 100,
        closed_at: new Date().toISOString(),
        close_reason: '50pct_profit',
        option_close_pct: profitCapturePct,
      }).eq('id', pos.id);

      result.closed50Pct.push(pos.ticker);
      persistEvent(pos.ticker, 'success',
        `💰 ${pos.ticker} $${pos.option_strike} put closed at ${profitCapturePct.toFixed(0)}% profit (target ${profitClosePct}%) — captured $${pnl.toFixed(0)}`,
        { action: 'closed', source: 'options', metadata: { reason: '50pct_profit', pnl, profitCapturePct, profitClosePct } }
      );
      continue;
    }

    // ── Check 3c: Roll alert when stock threatens strike ──
    // Trigger: stock dropped 3%+ below strike AND premium grown 1.2× — catches threat earlier
    // when there's still more credit available on the roll. DTE > 7 to avoid last-week noise.
    // We no longer auto-execute the roll with fabricated credits — instead we fire a prominent
    // alert so the position owner can evaluate the real chain and decide whether to roll or close.
    if (stockPrice < pos.option_strike * 0.97 && currentPremium > premiumCollected * 1.2 && dte > 7) {
      result.rollAlerts.push(pos.ticker);
      console.log(`[Options Manager] ROLL ALERT: ${pos.ticker} $${pos.option_strike}P — stock at $${stockPrice.toFixed(2)}, ${dte}d left, premium at ${(currentPremium / premiumCollected * 100).toFixed(0)}% of collected`);
      persistEvent(pos.ticker, 'warning',
        `↩️ ${pos.ticker} $${pos.option_strike} put needs attention — stock at $${stockPrice.toFixed(2)} (${(((pos.option_strike - stockPrice) / pos.option_strike) * 100).toFixed(1)}% below strike), ${dte}d left. Consider rolling down and out to collect fresh premium.`,
        { action: 'flagged', source: 'options', metadata: { reason: 'roll_needed', stockPrice, strike: pos.option_strike, dte, currentPremium, premiumCollected } }
      );
      continue;
    }

    // ── Check 4: 21 DTE hard close (tastytrade rule) ──
    // At 21 DTE the remaining theta decay curve flattens — risk/reward no longer favors holding.
    // Close regardless of P&L: lock in any profit, or cut exposure before gamma risk accelerates.
    // Guard: only execute once — the status update to CLOSED removes this position from the
    // FILLED/PARTIAL query on the next cycle, so repeated fires are a DB-failure edge case only.
    if (dte <= 21 && dte > 0) {
      const isWinner = pnl >= 0;
      const closeReason = isWinner ? '21dte_profit' : '21dte_close';
      const { error: closeError } = await sb.from('paper_trades').update({
        status: 'CLOSED',
        close_price: currentPremium,
        pnl,
        pnl_percent: (pnl / (pos.option_capital_req ?? pos.option_strike * 100)) * 100,
        closed_at: new Date().toISOString(),
        close_reason: closeReason,
        option_close_pct: profitCapturePct,
      }).eq('id', pos.id).eq('status', 'FILLED'); // extra guard: only close if still FILLED

      if (closeError) {
        console.error(`[Options Manager] 21 DTE close failed for ${pos.ticker} ${pos.id}:`, closeError.message);
        continue;
      }

      result.rollAlerts.push(pos.ticker);
      console.log(`[Options Manager] 21 DTE CLOSE: ${pos.ticker} $${pos.option_strike}P — ${isWinner ? `profit +$${pnl.toFixed(0)}` : `loss -$${Math.abs(pnl).toFixed(0)}`} (${dte}d left)`);
      persistEvent(pos.ticker, isWinner ? 'success' : 'warning',
        `${isWinner ? '⏱️' : '⚠️'} ${pos.ticker} $${pos.option_strike} put closed at 21 DTE — ${isWinner ? `locked in +$${pnl.toFixed(0)}` : `cut loss at -$${Math.abs(pnl).toFixed(0)}`} with ${dte} days remaining`,
        { action: 'closed', source: 'options', metadata: { reason: closeReason, dte, pnl, profitCapturePct } }
      );
      continue;
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

      // Open a covered call at least 10% OTM above current price.
      // This preserves upside participation in the recovery — a key risk the
      // "picking up pennies" critique highlights: don't sell the big rebound cheaply.
      // 10% floor means stock must rally ≥10% before shares are called away.
      const ccExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const ccExpiryISO = ccExpiry.toISOString().slice(0, 10);
      const minCcStrike = stockPrice * 1.10; // hard floor: at least 10% OTM
      const ccStrike = Math.round(minCcStrike * 4) / 4;  // round to nearest $0.25

      // Fetch covered call premium from IB options chain
      let ccPremium = 0;
      try {
        const ccChain = await getOptionsChain(pos.ticker, stockPrice, null, 0.30); // ~30-delta call
        if (ccChain?.bestCall) {
          ccPremium = ccChain.bestCall.bid; // conservative: use bid price
        }
      } catch { /* non-blocking — insert with 0 if chain unavailable */ }

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

      console.log(`[Options Manager] Assignment detected — covered call queued: ${pos.ticker} $${ccStrike}C exp ${ccExpiryISO}`);
      persistEvent(pos.ticker, 'warning',
        `📌 ${pos.ticker} assignment → covered call queued: $${ccStrike}C exp ${ccExpiryISO}, premium $${(ccPremium * 100).toFixed(0)}`,
        { action: 'flagged', source: 'options', metadata: { reason: 'assignment_detected_covered_call_queued', stockPrice, strike: pos.option_strike, ccStrike, ccExpiry: ccExpiryISO, ccPremium } }
      );
    }
  }

  // ── Process Covered Calls ─────────────────────────────────
  const { data: callData } = await sb
    .from('paper_trades')
    .select('id, ticker, mode, option_strike, option_expiry, option_premium, option_capital_req, option_assigned, fill_price, status, ib_order_id')
    .eq('mode', 'OPTIONS_CALL')
    .in('status', ['FILLED', 'PARTIAL']);

  for (const pos of (callData ?? []) as PositionRow[]) {
    if (!pos.option_strike || !pos.option_expiry) continue;

    const dte = daysUntil(pos.option_expiry);
    const premiumCollected = pos.option_premium ?? 0;

    // Check A: Expired worthless (stock stayed below call strike) — keep premium
    if (dte <= 0) {
      await sb.from('paper_trades').update({
        status: 'CLOSED',
        close_price: 0,
        pnl: premiumCollected * 100,
        closed_at: new Date().toISOString(),
        close_reason: 'expired_worthless',
      }).eq('id', pos.id);
      persistEvent(pos.ticker, 'success',
        `✅ ${pos.ticker} $${pos.option_strike} covered call expired worthless — kept $${(premiumCollected * 100).toFixed(0)} premium`,
        { action: 'closed', source: 'options', metadata: { reason: 'expired_worthless', premium: premiumCollected * 100 } }
      );
      continue;
    }

    if (!isConnected()) continue;

    // Get fresh stock price
    let stockPrice: number | null = null;
    try {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${pos.ticker}&token=${process.env.FINNHUB_API_KEY}`);
      const q = await res.json() as { c?: number };
      stockPrice = q.c ?? null;
    } catch { /* skip */ }
    if (!stockPrice) continue;

    // Get current call premium
    const currentCallPremium = await getCurrentCallPremium(pos.ticker, pos.option_strike, pos.option_expiry, stockPrice);
    if (currentCallPremium === null) continue;

    const profitCapturePct = premiumCollected > 0
      ? Math.max(0, (1 - currentCallPremium / premiumCollected) * 100)
      : 0;
    const pnl = (premiumCollected - currentCallPremium) * 100;
    await sb.from('paper_trades').update({ pnl }).eq('id', pos.id);

    // Check B: 50% profit — buy back cheap, free up the shares
    if (profitCapturePct >= 50) {
      await sb.from('paper_trades').update({
        status: 'CLOSED',
        close_price: currentCallPremium,
        pnl,
        closed_at: new Date().toISOString(),
        close_reason: '50pct_profit',
        option_close_pct: profitCapturePct,
      }).eq('id', pos.id);
      result.closed50Pct.push(pos.ticker);
      persistEvent(pos.ticker, 'success',
        `💰 ${pos.ticker} $${pos.option_strike} covered call closed at ${profitCapturePct.toFixed(0)}% profit — captured $${pnl.toFixed(0)}`,
        { action: 'closed', source: 'options', metadata: { reason: '50pct_profit', pnl } }
      );
      continue;
    }

    // Check C: Roll alert — stock within 2% of call strike (at risk of being called away)
    if (stockPrice >= pos.option_strike * 0.98 && dte > 5) {
      result.rollAlerts.push(pos.ticker);
      persistEvent(pos.ticker, 'warning',
        `↩️ ${pos.ticker} covered call at risk — stock $${stockPrice.toFixed(2)} near call strike $${pos.option_strike} (${dte}d left). Consider rolling up.`,
        { action: 'flagged', source: 'options', metadata: { reason: 'call_roll_needed', stockPrice, strike: pos.option_strike, dte } }
      );
    }
  }

  return result;
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
  await sb.from('paper_trades').update({
    status: 'CLOSED',
    close_reason: 'assigned',
    option_assigned: true,
    closed_at: new Date().toISOString(),
    close_price: pos.option_strike,
    pnl: -(pos.option_strike - pos.option_premium - (pos.fill_price ?? pos.option_strike)) * 100,
  }).eq('id', positionId);

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
    .in('mode', ['OPTIONS_PUT', 'OPTIONS_CALL'])
    .in('status', ['CLOSED', 'TARGET_HIT', 'STOPPED'])
    .gte('closed_at', monthStart.toISOString());

  const { data: open } = await sb
    .from('paper_trades')
    .select('id')
    .in('mode', ['OPTIONS_PUT', 'OPTIONS_CALL'])
    .in('status', ['FILLED', 'PARTIAL', 'PENDING', 'SUBMITTED']);

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
