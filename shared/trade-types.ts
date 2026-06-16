/**
 * Shared trade types — Single Source of Truth
 *
 * Canonical types for paper_trades, trade modes, statuses, and signals.
 * Imported by: auto-trader, frontend app, edge functions.
 * DO NOT duplicate these types elsewhere.
 */

export type AccountType = 'paper' | 'live';

export type RouteTarget = 'off' | 'paper' | 'live' | 'both';

export type TradeMode =
  | 'DAY_TRADE'
  | 'DAY_PENNY'
  | 'SWING_TRADE'
  | 'LONG_TERM'
  | 'OPTIONS_PUT'
  | 'OPTIONS_CALL'
  | 'OPTIONS_SCALP'
  | 'OPTIONS_LEAP'
  | 'CREDIT_SPREAD'
  | 'EARNINGS_CALENDAR';

export type TradeSignal = 'BUY' | 'SELL';

export type TradeStatus =
  | 'PENDING'
  | 'SUBMITTED'
  | 'FILLED'
  | 'PARTIAL'
  | 'STOPPED'
  | 'TARGET_HIT'
  | 'CLOSED'
  | 'CANCELLED'
  | 'REJECTED';

export type CloseReason =
  | 'stop_loss'
  | 'target_hit'
  | 'eod_close'
  | 'manual'
  | 'cancelled'
  | 'never_filled'
  | 'profit_take'
  | 'profit_take_50pct'
  | 'loss_cut'
  | 'stop_loss_100pct'
  | 'time_exit_21dte'
  | 'stale_eod_close'
  | 'stale_eod_reconcile'
  | 'stop_loss_hit'
  | 'rolled'
  | 'stopped'
  | 'expired_worthless'
  | 'expired_itm'
  | 'ib_fill_auto_created'
  | 'ib_reconciliation_cover';

/**
 * Full paper_trades row — superset of all columns used by any consumer.
 * Individual consumers may treat unused fields as optional/null.
 */
export interface PaperTrade {
  id: string;
  ticker: string;
  mode: TradeMode;
  signal: TradeSignal;
  strategy_source: string | null;
  strategy_source_url: string | null;
  strategy_video_id: string | null;
  strategy_video_heading: string | null;
  scanner_confidence: number | null;
  fa_confidence: number | null;
  fa_recommendation: string | null;
  entry_price: number | null;
  stop_loss: number | null;
  target_price: number | null;
  target_price2: number | null;
  risk_reward: string | null;
  quantity: number | null;
  position_size: number | null;
  ib_order_id: string | null;
  ib_parent_order_id: string | null;
  ib_tp_order_id: string | null;
  ib_sl_order_id: string | null;
  ib_close_order_id: string | null;
  status: TradeStatus;
  fill_price: number | null;
  close_price: number | null;
  pnl: number | null;
  ib_pnl: number | null;
  pnl_percent: number | null;
  opened_at: string;
  filled_at: string | null;
  closed_at: string | null;
  close_reason: CloseReason | null;
  scanner_reason: string | null;
  fa_rationale: Record<string, string> | null;
  notes: string | null;
  created_at: string;
  in_play_score?: number | null;
  pass1_confidence?: number | null;
  entry_trigger_type?: string | null;
  r_multiple?: number | null;
  market_condition?: string | null;
  pct_distance_sma20_at_entry?: number | null;
  macd_histogram_slope_at_entry?: string | null;
  volume_vs_10d_avg_at_entry?: number | null;
  regime_alignment_at_entry?: string | null;
  price_peak?: number | null;
  price_peak_date?: string | null;
  missing_since?: string | null;
  pnl_source?: string | null;
}
