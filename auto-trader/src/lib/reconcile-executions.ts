/**
 * End-of-day reconciliation: calls IB's reqExecutions to get today's fills,
 * compares against paper_trades, and corrects any fill_price / P&L discrepancies.
 *
 * Scheduled at 4:15 PM ET (after market close + EOD sweep).
 */

import { EventName } from '@stoqey/ib';
import { getIBApi, isConnected, getNextOrderId, getDefaultAccount } from '../ib-connection.js';
import { getSupabase, createAutoTradeEvent, type PaperTrade } from './supabase.js';
import { recalculatePerformance } from './feedback.js';

interface IBExecution {
  orderId: number;
  execId: string;
  ticker: string;
  side: string;
  shares: number;
  price: number;
  time: string;
}

function log(msg: string): void {
  console.log(`[Reconcile] ${msg}`);
}

export async function runEndOfDayReconciliation(): Promise<void> {
  if (!isConnected()) {
    log('Skipped — IB not connected');
    return;
  }

  const ib = getIBApi();
  if (!ib) {
    log('Skipped — no IB API instance');
    return;
  }

  const account = getDefaultAccount();
  if (!account) {
    log('Skipped — no account available');
    return;
  }

  log('Starting end-of-day reconciliation...');

  // Get today's date in ET for the IB filter
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const yyyy = etNow.getFullYear();
  const mm = String(etNow.getMonth() + 1).padStart(2, '0');
  const dd = String(etNow.getDate()).padStart(2, '0');
  const todayFilterET = `${yyyy}${mm}${dd} 00:00:00`;

  // 1. Request all of today's executions from IB
  const executions = await requestExecutions(ib, account, todayFilterET);
  log(`Received ${executions.length} executions from IB`);

  if (executions.length === 0) {
    log('No executions found — nothing to reconcile');
    await logReconciliationSummary(0, 0, 0, 0);
    return;
  }

  // 2. Get today's trades from paper_trades
  const sb = getSupabase();
  const todayStartET = new Date(etNow);
  todayStartET.setHours(0, 0, 0, 0);
  const todayStartUTC = new Date(todayStartET.toLocaleString('en-US', { timeZone: 'UTC' }));

  const { data: todayTrades } = await sb
    .from('paper_trades')
    .select('*')
    .or(`opened_at.gte.${todayStartUTC.toISOString()},closed_at.gte.${todayStartUTC.toISOString()},filled_at.gte.${todayStartUTC.toISOString()}`)
    .not('status', 'in', '(CANCELLED,REJECTED)');

  const trades = (todayTrades ?? []) as PaperTrade[];
  log(`Found ${trades.length} paper_trades for today`);

  // Build lookup: ib_order_id → trade
  const tradeByOrderId = new Map<number, PaperTrade>();
  const tradeByTpOrderId = new Map<number, PaperTrade>();
  const tradeBySlOrderId = new Map<number, PaperTrade>();

  for (const t of trades) {
    if (t.ib_order_id) tradeByOrderId.set(parseInt(t.ib_order_id, 10), t);
    if (t.ib_tp_order_id) tradeByTpOrderId.set(parseInt(t.ib_tp_order_id, 10), t);
    if (t.ib_sl_order_id) tradeBySlOrderId.set(parseInt(t.ib_sl_order_id, 10), t);
  }

  // 3. Reconcile
  let corrected = 0;
  let orphaned = 0;
  let matched = 0;
  const correctionDetails: string[] = [];

  for (const exec of executions) {
    // Try to match by order ID — could be parent (entry), TP, or SL
    let trade = tradeByOrderId.get(exec.orderId);
    let matchType: 'entry' | 'tp' | 'sl' = 'entry';

    if (!trade) {
      trade = tradeByTpOrderId.get(exec.orderId);
      matchType = 'tp';
    }
    if (!trade) {
      trade = tradeBySlOrderId.get(exec.orderId);
      matchType = 'sl';
    }

    if (!trade) {
      orphaned++;
      log(`Orphaned execution: order ${exec.orderId} ${exec.side} ${exec.shares}x ${exec.ticker} @ $${exec.price.toFixed(2)}`);
      continue;
    }

    matched++;

    if (matchType === 'entry') {
      // Check entry fill price
      const currentFill = trade.fill_price;
      if (currentFill != null && Math.abs(currentFill - exec.price) > 0.005) {
        const qty = trade.quantity ?? 1;
        const isLong = trade.signal === 'BUY';

        const updates: Record<string, unknown> = { fill_price: exec.price };

        // If trade is closed, recalculate P&L with corrected fill price
        if (trade.close_price != null && trade.close_price > 0) {
          const pnl = isLong
            ? (trade.close_price - exec.price) * qty
            : (exec.price - trade.close_price) * qty;
          updates.pnl = parseFloat(pnl.toFixed(2));
          updates.pnl_percent = parseFloat(((pnl / (exec.price * qty)) * 100).toFixed(2));
        }

        await sb.from('paper_trades').update(updates).eq('id', trade.id);
        corrected++;
        correctionDetails.push(`${trade.ticker}: fill_price ${currentFill.toFixed(2)} → ${exec.price.toFixed(2)}`);
        log(`Corrected ${trade.ticker} fill_price: $${currentFill.toFixed(2)} → $${exec.price.toFixed(2)}`);
      }
    } else {
      // TP or SL fill — check close price
      if (['STOPPED', 'TARGET_HIT', 'CLOSED'].includes(trade.status) && trade.close_price != null) {
        if (Math.abs(trade.close_price - exec.price) > 0.005) {
          const fillPrice = trade.fill_price ?? trade.entry_price ?? 0;
          const qty = trade.quantity ?? 1;
          const isLong = trade.signal === 'BUY';
          const pnl = isLong
            ? (exec.price - fillPrice) * qty
            : (fillPrice - exec.price) * qty;

          await sb.from('paper_trades').update({
            close_price: exec.price,
            pnl: parseFloat(pnl.toFixed(2)),
            pnl_percent: fillPrice > 0 ? parseFloat(((pnl / (fillPrice * qty)) * 100).toFixed(2)) : null,
          }).eq('id', trade.id);
          corrected++;
          correctionDetails.push(`${trade.ticker}: close_price ${trade.close_price.toFixed(2)} → ${exec.price.toFixed(2)}`);
          log(`Corrected ${trade.ticker} close_price: $${trade.close_price.toFixed(2)} → $${exec.price.toFixed(2)}`);
        }
      }
    }
  }

  // 4. Check for trades with IB orders but no matching execution (potential issues)
  let flagged = 0;
  for (const trade of trades) {
    if (trade.status === 'FILLED' && trade.ib_order_id) {
      const orderId = parseInt(trade.ib_order_id, 10);
      const hasExec = executions.some(e => e.orderId === orderId);
      if (!hasExec) {
        // Not necessarily an error — trade may have been filled on a prior day
        const filledAt = trade.filled_at ? new Date(trade.filled_at) : null;
        const isFilledToday = filledAt && filledAt >= todayStartUTC;
        if (isFilledToday) {
          flagged++;
          log(`[FLAG] ${trade.ticker}: FILLED today but no IB execution found (orderId=${orderId})`);
        }
      }
    }
  }

  // 5. Recalculate global performance if corrections were made
  if (corrected > 0) {
    log(`Recalculating trade_performance after ${corrected} corrections...`);
    await recalculatePerformance();
  }

  // 6. Log summary
  await logReconciliationSummary(matched, corrected, orphaned, flagged, correctionDetails);
  log(`Done: ${matched} matched, ${corrected} corrected, ${orphaned} orphaned, ${flagged} flagged`);
}

function requestExecutions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ib: any,
  account: string,
  timeFilter: string
): Promise<IBExecution[]> {
  return new Promise((resolve) => {
    const reqId = getNextOrderId();
    const executions: IBExecution[] = [];
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(executions);
      }
    }, 15_000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detailHandler = (rId: number, contract: any, execution: any) => {
      if (rId !== reqId || resolved) return;
      executions.push({
        orderId: execution?.orderId ?? 0,
        execId: execution?.execId ?? '',
        ticker: contract?.symbol ?? '',
        side: execution?.side ?? '',
        shares: execution?.shares ?? execution?.cumQty ?? 0,
        price: execution?.price ?? execution?.avgPrice ?? 0,
        time: execution?.time ?? '',
      });
    };

    const endHandler = (rId: number) => {
      if (rId !== reqId || resolved) return;
      resolved = true;
      clearTimeout(timeout);
      ib.off(EventName.execDetails, detailHandler);
      ib.off(EventName.execDetailsEnd, endHandler);
      resolve(executions);
    };

    ib.on(EventName.execDetails, detailHandler);
    ib.on(EventName.execDetailsEnd, endHandler);

    ib.reqExecutions(reqId, {
      acctCode: account,
      time: timeFilter,
    });
  });
}

async function logReconciliationSummary(
  matched: number,
  corrected: number,
  orphaned: number,
  flagged: number,
  details?: string[]
): Promise<void> {
  try {
    await createAutoTradeEvent({
      ticker: 'SYSTEM',
      action: 'RECONCILIATION',
      source: 'system',
      message: `EOD reconciliation: ${matched} matched, ${corrected} corrected, ${orphaned} orphaned, ${flagged} flagged`,
      metadata: {
        status: corrected > 0 ? 'CORRECTED' : 'OK',
        matched, corrected, orphaned, flagged,
        notes: (details ?? []).join('\n') || undefined,
      },
    });
  } catch (err) {
    log(`Failed to log reconciliation summary: ${err instanceof Error ? err.message : err}`);
  }
}
