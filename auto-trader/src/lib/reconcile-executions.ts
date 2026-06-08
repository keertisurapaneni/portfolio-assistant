/**
 * End-of-day reconciliation: calls IB's reqExecutions to get today's fills,
 * compares against paper_trades, and corrects any fill_price / P&L discrepancies.
 *
 * Scheduled at 4:15 PM ET (after market close + EOD sweep).
 */

import { EventName } from '@stoqey/ib';
import { getIBApi, isConnected, getNextOrderId, getDefaultAccount, type IBConnection, getConnectionForAccount } from '../ib-connection.js';
import { getSupabase, createAutoTradeEvent, tradesTable, type PaperTrade } from './supabase.js';
import { recalculatePerformance } from './feedback.js';
import type { AccountType } from '../../../shared/trade-types.js';

interface IBExecution {
  orderId: number;
  execId: string;
  ticker: string;
  side: string;
  shares: number;
  price: number;
  time: string;
  /** IB's FIFO-based realized P&L from the commissionReport event.
   *  Available for SELL/SLD executions. Already commission-inclusive (matches IB app display).
   *  Undefined if IB didn't send a commission report for this execution. */
  realizedPnl?: number;
}

function log(msg: string): void {
  console.log(`[Reconcile] ${msg}`);
}

export async function runEndOfDayReconciliation(accountType: AccountType = 'paper'): Promise<void> {
  const conn = getConnectionForAccount(accountType);
  if (!conn.isConnected()) {
    log(`Skipped — IB:${accountType} not connected`);
    return;
  }

  const ib = conn.getIBApi();
  if (!ib) {
    log(`Skipped — no IB:${accountType} API instance`);
    return;
  }

  const account = conn.getDefaultAccount();
  if (!account) {
    log(`Skipped — no IB:${accountType} account available`);
    return;
  }

  log(`Starting end-of-day reconciliation for ${accountType}...`);

  // Get today's date in ET for the IB filter
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const yyyy = etNow.getFullYear();
  const mm = String(etNow.getMonth() + 1).padStart(2, '0');
  const dd = String(etNow.getDate()).padStart(2, '0');
  const todayFilterET = `${yyyy}${mm}${dd} 00:00:00`;

  // 1. Request all of today's executions from IB
  const executions = await requestExecutions(ib, account, todayFilterET, conn);
  log(`Received ${executions.length} executions from IB`);

  if (executions.length === 0) {
    log('No executions found — nothing to reconcile');
    await logReconciliationSummary(0, 0, 0, 0, undefined, accountType);
    return;
  }

  // 2. Get today's trades from paper_trades
  const sb = getSupabase();
  const todayStartET = new Date(etNow);
  todayStartET.setHours(0, 0, 0, 0);
  const todayStartUTC = new Date(todayStartET.toLocaleString('en-US', { timeZone: 'UTC' }));

  const tTable = tradesTable(accountType);
  const { data: todayTrades } = await sb
    .from(tTable)
    .select('*')
    .or(`opened_at.gte.${todayStartUTC.toISOString()},closed_at.gte.${todayStartUTC.toISOString()},filled_at.gte.${todayStartUTC.toISOString()}`)
    .not('status', 'in', '(CANCELLED,REJECTED)');

  const trades = (todayTrades ?? []) as PaperTrade[];
  log(`Found ${trades.length} ${tTable} for today`);

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
      // Before giving up, check if this is a cover buy for a reconcile_cover short.
      // reconcileIBShorts stores the cover orderId in ib_order_id so we can match here.
      const isCoverBuy = exec.side === 'BOT' || exec.side === 'BUY';
      if (isCoverBuy) {
        const { data: coverTrade } = await sb
          .from(tTable)
          .select('*')
          .eq('ticker', exec.ticker)
          .eq('close_reason', 'reconcile_cover')
          .or('close_price.is.null,close_price.eq.0')
          .order('opened_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (coverTrade) {
          const ct = coverTrade as PaperTrade;
          const fillPrice = ct.fill_price ?? ct.entry_price ?? 0;
          const qty = ct.quantity ?? 1;
          // For a covered short: entry was SELL (fill_price is the short entry), cover is BUY (exec.price)
          const pnl = (fillPrice - exec.price) * qty;
          await sb.from(tTable).update({
            close_price: exec.price,
            pnl: parseFloat(pnl.toFixed(2)),
            pnl_percent: fillPrice > 0 ? parseFloat(((pnl / (fillPrice * qty)) * 100).toFixed(2)) : null,
          }).eq('id', ct.id);
          corrected++;
          correctionDetails.push(`${exec.ticker}: reconcile_cover close_price → ${exec.price.toFixed(2)} (pnl $${pnl.toFixed(2)})`);
          log(`Reconciled cover for ${exec.ticker}: close_price=$${exec.price.toFixed(2)}, pnl=$${pnl.toFixed(2)}`);
          matched++;
          continue;
        }
      }

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

        await sb.from(tTable).update(updates).eq('id', trade.id);
        corrected++;
        correctionDetails.push(`${trade.ticker}: fill_price ${currentFill.toFixed(2)} → ${exec.price.toFixed(2)}`);
        log(`Corrected ${trade.ticker} fill_price: $${currentFill.toFixed(2)} → $${exec.price.toFixed(2)}`);
      }
    } else {
      // TP, SL, trailing-stop, or EOD close fill — correct close price and P&L.
      // Also handles cases where close_price was null (e.g. trailing stop wrote CLOSED
      // without close_price) or was set to fill_price with pnl=0 (browser sync fallback).
      if (['STOPPED', 'TARGET_HIT', 'CLOSED'].includes(trade.status)) {
        const currentClose = trade.close_price ?? 0;
        const needsCorrection = currentClose === null
          || currentClose === 0
          || (trade.fill_price != null && Math.abs(currentClose - (trade.fill_price as number)) < 0.005 && (trade.pnl ?? 0) === 0)
          || Math.abs(currentClose - exec.price) > 0.005;

        if (needsCorrection) {
          const fillPrice = trade.fill_price ?? trade.entry_price ?? 0;
          const qty = trade.quantity ?? 1;
          const isLong = trade.signal === 'BUY';

          // Prefer IB's own realizedPnl from the commissionReport — it uses IB's FIFO
          // cost basis which may differ from our fill_price when orphaned prior-day lots
          // exist. Without this, a trade where IB FIFO used a cheaper old lot would show
          // as a loss in our system while IB shows it as a gain.
          let pnl: number;
          let pnlSource: string;
          if (exec.realizedPnl != null) {
            pnl = exec.realizedPnl;
            pnlSource = 'ib_realized_pnl';
          } else {
            pnl = isLong
              ? (exec.price - fillPrice) * qty
              : (fillPrice - exec.price) * qty;
            pnlSource = 'calculated';
          }

          const costBasis = fillPrice * qty;
          const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;

          await sb.from(tTable).update({
            close_price: exec.price,
            pnl: parseFloat(pnl.toFixed(2)),
            pnl_percent: parseFloat(pnlPct.toFixed(2)),
          }).eq('id', trade.id);
          corrected++;
          const prevStr = currentClose != null ? currentClose.toFixed(2) : 'null';
          correctionDetails.push(`${trade.ticker}: close_price ${prevStr} → ${exec.price.toFixed(2)} (pnl $${pnl.toFixed(2)} via ${pnlSource})`);
          log(`Corrected ${trade.ticker} close_price: $${prevStr} → $${exec.price.toFixed(2)}, pnl: $${pnl.toFixed(2)} [${pnlSource}]`);
        }
      }
    }
  }

  // 3b. Patch zero-pnl ghost records (ib_fill_auto_created) using IB execution realizedPnl.
  //
  // Ghost records are created by the DB trigger when a SELL fill arrives but no matching
  // open paper_trade exists. The trigger inserts pnl = COALESCE(realized_pnl, 0) — if the
  // IB commission report arrives before the trigger fires, pnl is correct. If it arrives
  // after (or never arrives), the ghost is stuck at pnl=0.
  //
  // The main loop above can't fix this because it only looks up by ib_order_id /
  // ib_tp_order_id / ib_sl_order_id — ghosts only have ib_close_order_id.
  //
  // Safety constraints:
  //   - Only touch records with close_reason='ib_fill_auto_created' (never touch normal trades)
  //   - Only patch when pnl=0 (trigger already set a non-zero value → leave it alone)
  //   - Only patch when exec.realizedPnl is available (never guess from fill price)
  {
    const ghostTrades = trades.filter(t =>
      t.close_reason === 'ib_fill_auto_created' &&
      t.pnl === 0 &&
      t.ib_close_order_id != null,
    );

    if (ghostTrades.length > 0) {
      log(`Checking ${ghostTrades.length} zero-pnl ghost record(s) for IB realizedPnl...`);

      // Group executions by orderId for O(1) lookup
      const execsByOrderId = new Map<number, IBExecution[]>();
      for (const exec of executions) {
        const bucket = execsByOrderId.get(exec.orderId) ?? [];
        bucket.push(exec);
        execsByOrderId.set(exec.orderId, bucket);
      }

      for (const ghost of ghostTrades) {
        const closeOrderId = parseInt(ghost.ib_close_order_id!, 10);
        const matchingExecs = execsByOrderId.get(closeOrderId);

        if (!matchingExecs || matchingExecs.length === 0) {
          log(`Ghost ${ghost.ticker} (closeOrder ${closeOrderId}): no matching IB execution — cannot patch`);
          continue;
        }

        // Sum realizedPnl across all partial-fill executions for this order
        const rpnls = matchingExecs
          .map(e => e.realizedPnl)
          .filter((p): p is number => p != null);

        if (rpnls.length === 0) {
          log(`Ghost ${ghost.ticker} (closeOrder ${closeOrderId}): commission report not available — pnl stays 0`);
          continue;
        }

        const totalPnl = parseFloat(rpnls.reduce((s, p) => s + p, 0).toFixed(2));

        await sb.from(tTable).update({
          pnl:        totalPnl,
          pnl_source: 'ib_realized_pnl',
        }).eq('id', ghost.id);

        corrected++;
        correctionDetails.push(`${ghost.ticker}: ghost pnl 0 → ${totalPnl} [IB realized, closeOrder ${closeOrderId}]`);
        log(`Patched ghost ${ghost.ticker} (closeOrder ${closeOrderId}): pnl 0 → $${totalPnl.toFixed(2)}`);
      }
    }
  }

  // 3c. Link ghost close records to their still-open (FILLED) real paper_trades.
  //
  // Root cause: when IB closes a position that our system didn't initiate (e.g. bracket SL/TP
  // fires, position aged out, or manual close), the ib_fill trigger creates a ghost record
  // (close_reason='ib_fill_auto_created') because no paper_trade has ib_close_order_id matching
  // the fill's order ID. The real paper_trade stays FILLED indefinitely.
  //
  // Fix: for each ghost, find any FILLED paper_trade with the same ticker + mode. Sum all ghost
  // P&Ls for that position, close the real trade, and zero the ghosts to avoid double-counting.
  //
  // Safety constraints:
  //   - Only match SWING_TRADE / LONG_TERM modes (day trades close the same day via other paths)
  //   - Only match when the ghost's ticker + mode matches the real trade's ticker + mode
  //   - Require that the real trade was opened before the ghost was created
  //   - If multiple real trades exist for the same ticker+mode, use the oldest FILLED one
  {
    const ghostLinked = await reconcileGhostCloses(tTable, accountType);
    if (ghostLinked > 0) {
      corrected += ghostLinked;
      correctionDetails.push(`reconcileGhostCloses: ${ghostLinked} real trade(s) closed via ghost records`);
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
  await logReconciliationSummary(matched, corrected, orphaned, flagged, correctionDetails, accountType);
  log(`Done (${accountType}): ${matched} matched, ${corrected} corrected, ${orphaned} orphaned, ${flagged} flagged`);
}

/**
 * Link `ib_fill_auto_created` ghost records to their corresponding still-open FILLED paper_trades.
 *
 * This handles the case where IB closes a SWING_TRADE or LONG_TERM position that our code didn't
 * initiate (bracket SL/TP, manual close, etc.). The DB trigger sees the SELL fill, finds no
 * matching open paper_trade with ib_close_order_id set, and creates a ghost. The real trade stays
 * FILLED. This function links the two:
 *   1. Find ghosts closed in the last 7 days with mode in [SWING_TRADE, LONG_TERM]
 *   2. For each ticker+mode pair, find the oldest FILLED real paper_trade
 *   3. Sum the ghost P&Ls and close the real trade, zero the ghosts
 *
 * Safe to call at any time — only touches records with close_reason='ib_fill_auto_created'.
 * Returns the number of real paper_trades that were closed.
 */
export async function reconcileGhostCloses(
  tTable: string = 'paper_trades',
  accountType: AccountType = 'paper',
): Promise<number> {
  const sb = getSupabase();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Fetch recent ghosts for SWING_TRADE / LONG_TERM
  const { data: ghosts, error: ghostsErr } = await sb
    .from(tTable)
    .select('id, ticker, mode, pnl, close_price, ib_close_order_id, closed_at, notes')
    .eq('close_reason', 'ib_fill_auto_created')
    .eq('status', 'CLOSED')
    .in('mode', ['SWING_TRADE', 'LONG_TERM'])
    .gte('closed_at', sevenDaysAgo)
    .neq('pnl', 0); // already-zeroed ghosts are already handled

  if (ghostsErr) {
    log(`[GhostClose] Error fetching ghosts: ${ghostsErr.message}`);
    return 0;
  }

  const ghostList = (ghosts ?? []) as Array<{
    id: string; ticker: string; mode: string; pnl: number | null;
    close_price: number | null; ib_close_order_id: string | null;
    closed_at: string; notes: string | null;
  }>;

  if (ghostList.length === 0) {
    log('[GhostClose] No unlinked ghosts found — skipping');
    return 0;
  }

  log(`[GhostClose] Found ${ghostList.length} unlinked ghost(s) across SWING_TRADE/LONG_TERM`);

  // Group ghosts by ticker+mode
  const grouped = new Map<string, typeof ghostList>();
  for (const g of ghostList) {
    const key = `${g.ticker}|${g.mode}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(g);
    grouped.set(key, bucket);
  }

  let linked = 0;

  for (const [key, ghostGroup] of grouped) {
    const [ticker, mode] = key.split('|');
    const latestGhostAt = ghostGroup.reduce(
      (latest, g) => (g.closed_at > latest ? g.closed_at : latest),
      ghostGroup[0].closed_at,
    );
    const latestGhost = ghostGroup.find(g => g.closed_at === latestGhostAt)!;

    // Find the oldest still-FILLED real paper_trade for this ticker+mode
    const { data: realTrades } = await sb
      .from(tTable)
      .select('id, ticker, mode, fill_price, quantity, signal, opened_at, pnl, notes')
      .eq('ticker', ticker)
      .eq('mode', mode)
      .eq('status', 'FILLED')
      .lt('opened_at', latestGhostAt) // opened before the ghost was created
      .neq('close_reason', 'ib_fill_auto_created')
      .order('opened_at', { ascending: true })
      .limit(1);

    const realTrade = (realTrades ?? [])[0] as {
      id: string; ticker: string; mode: string; fill_price: number | null;
      quantity: number | null; signal: string; opened_at: string;
      pnl: number | null; notes: string | null;
    } | undefined;

    if (!realTrade) {
      log(`[GhostClose] ${ticker} (${mode}): no FILLED real trade found — ghost(s) left unchanged`);
      continue;
    }

    // Sum the P&L across all ghosts for this position
    const combinedPnl = parseFloat(
      ghostGroup.reduce((s, g) => s + (g.pnl ?? 0), 0).toFixed(2),
    );
    const latestClosePrice = latestGhost.close_price;
    const closedAt = latestGhost.closed_at;
    const closeOrderIds = ghostGroup
      .map(g => g.ib_close_order_id)
      .filter(Boolean)
      .join(',');

    log(
      `[GhostClose] Closing ${ticker} real trade ${realTrade.id} ` +
      `(opened ${realTrade.opened_at}) via ${ghostGroup.length} ghost(s) — ` +
      `pnl=$${combinedPnl.toFixed(2)}, closePrice=$${latestClosePrice ?? 'N/A'}, orders=[${closeOrderIds}]`,
    );

    // Close the real trade
    const { error: closeErr } = await sb.from(tTable).update({
      status: 'CLOSED',
      close_price: latestClosePrice,
      close_reason: 'eod_close',
      pnl: combinedPnl,
      pnl_source: 'ib_realized',
      closed_at: closedAt,
      ib_close_order_id: latestGhost.ib_close_order_id,
      notes: `Closed via reconcileGhostCloses — ${ghostGroup.length} IB fill ghost(s) [${closeOrderIds}] combined pnl $${combinedPnl.toFixed(2)}`,
    }).eq('id', realTrade.id);

    if (closeErr) {
      log(`[GhostClose] Error closing ${ticker} real trade: ${closeErr.message}`);
      continue;
    }

    // Zero out all ghosts that were linked to this real trade
    for (const g of ghostGroup) {
      await sb.from(tTable).update({
        pnl: 0,
        notes: `duplicate ghost — attributed to real paper_trade ${realTrade.id} by reconcileGhostCloses (pnl zeroed)`,
      }).eq('id', g.id);
    }

    await createAutoTradeEvent({
      ticker,
      event_type: 'info',
      action: 'GHOST_CLOSE_LINKED',
      source: 'system',
      message: `[GhostClose] ${ticker} (${mode}): closed real trade ${realTrade.id} using ${ghostGroup.length} ghost record(s). Combined P&L: $${combinedPnl.toFixed(2)}.`,
      metadata: {
        realTradeId: realTrade.id,
        ghostIds: ghostGroup.map(g => g.id),
        closeOrderIds,
        combinedPnl,
        latestClosePrice,
      },
    }, accountType);

    linked++;
  }

  if (linked > 0) {
    log(`[GhostClose] ✓ Linked and closed ${linked} real trade(s) via ghost records`);
  } else {
    log('[GhostClose] No ghost→trade links were made (all tickers already closed or no match)');
  }

  return linked;
}

function requestExecutions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ib: any,
  account: string,
  timeFilter: string,
  conn: IBConnection,
): Promise<IBExecution[]> {
  return new Promise((resolve) => {
    const reqId = conn.getNextOrderId();
    const executions: IBExecution[] = [];
    // execId → realizedPnl from IB's commissionReport. IB fires commissionReport for each
    // execution, usually shortly after execDetails, but may arrive after execDetailsEnd.
    const realizedPnlByExecId = new Map<string, number>();
    let resolved = false;

    // Hard timeout — ensures we always resolve even if commissionReports are slow.
    const hardTimeout = setTimeout(() => {
      if (!resolved) finalize();
    }, 15_000);

    function finalize() {
      if (resolved) return;
      resolved = true;
      clearTimeout(hardTimeout);
      clearTimeout(commissionWaitTimer);
      ib.off(EventName.execDetails, detailHandler);
      ib.off(EventName.execDetailsEnd, endHandler);
      ib.off(EventName.commissionReport, commissionHandler);
      // Merge commissionReport realizedPnl into executions
      for (const exec of executions) {
        const rpnl = realizedPnlByExecId.get(exec.execId);
        if (rpnl != null && isFinite(rpnl) && Math.abs(rpnl) < 1e6) {
          exec.realizedPnl = rpnl;
        }
      }
      resolve(executions);
    }

    // After execDetailsEnd, wait 2 s for any lagging commissionReport events, then finalize.
    let commissionWaitTimer: ReturnType<typeof setTimeout>;

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
      ib.off(EventName.execDetails, detailHandler);
      ib.off(EventName.execDetailsEnd, endHandler);
      // Give commission reports 2 s to arrive before finalizing
      commissionWaitTimer = setTimeout(finalize, 2_000);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const commissionHandler = (report: any) => {
      if (resolved) return;
      const execId: string | undefined = report?.execId;
      const rpnl: number | undefined = report?.realizedPNL ?? report?.realizedPnl;
      if (execId && rpnl != null && isFinite(rpnl) && Math.abs(rpnl) < 1e6) {
        realizedPnlByExecId.set(execId, rpnl);
      }
    };

    ib.on(EventName.execDetails, detailHandler);
    ib.on(EventName.execDetailsEnd, endHandler);
    ib.on(EventName.commissionReport, commissionHandler);

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
  details?: string[],
  accountType: AccountType = 'paper',
): Promise<void> {
  try {
    await createAutoTradeEvent({
      ticker: 'SYSTEM',
      event_type: 'info',
      action: 'RECONCILIATION',
      source: 'system',
      message: `EOD reconciliation: ${matched} matched, ${corrected} corrected, ${orphaned} orphaned, ${flagged} flagged`,
      metadata: {
        status: corrected > 0 ? 'CORRECTED' : 'OK',
        matched, corrected, orphaned, flagged,
        notes: (details ?? []).join('\n') || undefined,
      },
    }, accountType);
  } catch (err) {
    log(`Failed to log reconciliation summary: ${err instanceof Error ? err.message : err}`);
  }
}
