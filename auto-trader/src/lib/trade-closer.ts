/**
 * recordTradeClose() — Single Writer for all trade closes.
 *
 * Every code path that marks a trade as CLOSED/TARGET_HIT/STOPPED must call
 * this function. It ensures:
 *   1. P&L is computed from the best available source (IB realized > fill calc > fallback)
 *   2. pnl_source provenance is always set
 *   3. INVARIANT: status=CLOSED ⟹ close_price IS NOT NULL
 *   4. INVARIANT: close_price IS NOT NULL ⟹ pnl IS NOT NULL
 */

import type { AccountType, TradeStatus, CloseReason, PaperTrade } from '../../../shared/trade-types.js';
import { getSupabase, updatePaperTrade, createAutoTradeEvent, fillsTable } from './supabase.js';

export type PnlSource = 'ib_realized' | 'ib_fill_calculated' | 'quote_fallback' | 'estimated' | 'legacy';

export interface CloseTradeParams {
  tradeId: string;
  closePrice: number;
  closeReason: string;
  status: 'CLOSED' | 'TARGET_HIT' | 'STOPPED';
  orderId?: number;
  accountType: AccountType;
  /** Override P&L (for options/spreads where P&L is premium-based) */
  overridePnl?: number;
  overridePnlPct?: number;
  overridePnlSource?: PnlSource;
  /**
   * Explicit position direction for P&L sign calculation.
   * Required when the trade record's `signal` field reflects a close *action* rather than
   * the original entry direction — specifically partial loss cut child records (signal='SELL'
   * for display, but the underlying position was long). Without this, the fallback formula
   * treats the close as a short cover and flips the sign.
   *
   * TODO(architecture): The real fix is a `display_action` column on paper_trades so that
   * `signal` always means entry direction and display derives from `display_action ?? signal`.
   * Until then, callers creating child records must pass this explicitly.
   */
  positionDirection?: 'LONG' | 'SHORT';
  /** Extra fields to write (r_multiple, notes, missing_since, etc.) */
  extraUpdates?: Record<string, unknown>;
}

export async function recordTradeClose(params: CloseTradeParams): Promise<void> {
  const {
    tradeId, closePrice, closeReason, status, orderId,
    accountType, overridePnl, overridePnlPct, overridePnlSource, positionDirection, extraUpdates,
  } = params;

  // 1. Look up the trade
  const sb = getSupabase();
  const table = accountType === 'live' ? 'live_trades' : 'paper_trades';
  const { data: trade, error: tradeErr } = await sb
    .from(table)
    .select('*')
    .eq('id', tradeId)
    .single();

  if (tradeErr || !trade) {
    console.error(`[TradeCloser] Trade ${tradeId} not found: ${tradeErr?.message ?? 'no data'}`);
    return;
  }

  const fillPrice = (trade as PaperTrade).fill_price ?? (trade as PaperTrade).entry_price ?? 0;
  const qty = (trade as PaperTrade).quantity ?? 0;
  const signal = (trade as PaperTrade).signal;

  let pnl: number;
  let pnlPct: number | null;
  let pnlSource: PnlSource;

  if (overridePnl != null) {
    // Options/spreads pass pre-computed P&L
    pnl = overridePnl;
    pnlPct = overridePnlPct ?? (fillPrice * qty > 0 ? (overridePnl / (fillPrice * qty)) * 100 : null);
    pnlSource = overridePnlSource ?? 'ib_fill_calculated';
  } else {
    // 2. Check ib_fills for realizedPnl from commissionReport.
    // Penny stocks fill in many 100-share chunks — SUM all fills for the order
    // rather than taking the first row (LIMIT 1 would give a ~100-share slice P&L).
    let ibRealizedPnl: number | null = null;
    if (orderId != null) {
      const fillsTableName = fillsTable(accountType);
      const { data: fills } = await sb
        .from(fillsTableName)
        .select('realized_pnl')
        .eq('order_id', orderId)
        .not('realized_pnl', 'is', null);

      if (fills && fills.length > 0) {
        const totalRpnl = fills.reduce((sum, f) => sum + (f.realized_pnl as number), 0);
        if (isFinite(totalRpnl) && Math.abs(totalRpnl) < 1e6) {
          ibRealizedPnl = totalRpnl;
        }
      }
    }

    if (ibRealizedPnl != null) {
      // 3a. IB realized P&L from commissionReport — most accurate
      pnl = ibRealizedPnl;
      pnlSource = 'ib_realized';
    } else {
      // 3b. Calculate from fill prices.
      // positionDirection overrides signal-based inference — needed for partial loss cut
      // child records where signal='SELL' (display) but the underlying position is LONG.
      const isLong = positionDirection
        ? positionDirection === 'LONG'
        : signal === 'BUY';
      pnl = isLong
        ? (closePrice - fillPrice) * qty
        : (fillPrice - closePrice) * qty;
      pnlSource = closePrice > 0 ? 'ib_fill_calculated' : 'quote_fallback';
    }

    const costBasis = fillPrice * qty;
    pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : null;
  }

  // 4. Write atomically
  const updates: Record<string, unknown> = {
    status,
    close_price: closePrice,
    close_reason: closeReason,
    pnl: parseFloat(pnl.toFixed(2)),
    pnl_percent: pnlPct != null ? parseFloat(pnlPct.toFixed(2)) : null,
    pnl_source: pnlSource,
    closed_at: new Date().toISOString(),
    // Store close orderId so the trigger can retroactively patch pnl with
    // IB's net realized_pnl when the commission report arrives asynchronously.
    ...(orderId != null ? { ib_close_order_id: orderId.toString() } : {}),
    ...(extraUpdates ?? {}),
  };

  await updatePaperTrade(tradeId, updates, accountType);
}
