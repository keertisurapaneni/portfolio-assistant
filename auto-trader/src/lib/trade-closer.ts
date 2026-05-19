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
  /** Extra fields to write (r_multiple, notes, missing_since, etc.) */
  extraUpdates?: Record<string, unknown>;
}

export async function recordTradeClose(params: CloseTradeParams): Promise<void> {
  const {
    tradeId, closePrice, closeReason, status, orderId,
    accountType, overridePnl, overridePnlPct, overridePnlSource, extraUpdates,
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
    // 2. Check ib_fills for realizedPnl from commissionReport
    let ibRealizedPnl: number | null = null;
    if (orderId != null) {
      const fillsTableName = fillsTable(accountType);
      const { data: fills } = await sb
        .from(fillsTableName)
        .select('realized_pnl')
        .eq('order_id', orderId)
        .not('realized_pnl', 'is', null)
        .limit(1);

      if (fills && fills.length > 0 && fills[0].realized_pnl != null) {
        const rpnl = fills[0].realized_pnl as number;
        if (isFinite(rpnl) && Math.abs(rpnl) < 1e6) {
          ibRealizedPnl = rpnl;
        }
      }
    }

    if (ibRealizedPnl != null) {
      // 3a. IB realized P&L from commissionReport — most accurate
      pnl = ibRealizedPnl;
      pnlSource = 'ib_realized';
    } else {
      // 3b. Calculate from fill prices
      const isLong = signal === 'BUY';
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
    ...(extraUpdates ?? {}),
  };

  await updatePaperTrade(tradeId, updates, accountType);
}
