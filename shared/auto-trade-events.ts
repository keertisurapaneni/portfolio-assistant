/**
 * Shared auto-trade event types — Single Source of Truth
 *
 * String-literal unions and interfaces for auto_trade_events table.
 * Imported by: auto-trader, frontend app.
 * DO NOT duplicate these types elsewhere.
 */

import type { TradeMode } from './trade-types.js';

export type AutoTradeAction =
  | 'executed'
  | 'closed'
  | 'skipped'
  | 'failed'
  | 'proceeding'
  | 'health_check'
  | 'RECONCILIATION'
  | 'GHOST_CLOSE_LINKED'
  | 'scan_complete';

export type AutoTradeSource =
  | 'scanner'
  | 'suggested_finds'
  | 'manual'
  | 'system'
  | 'dip_buy'
  | 'profit_take'
  | 'loss_cut'
  | 'lt_auto_sell'
  | 'swing_expiry'
  | 'capital_pressure'
  | 'external_signal'
  | 'spx_level_scanner'
  | 'earnings_scanner'
  | 'watchlist_screener'
  | 'compounder_health';

export type AutoTradeEventType = 'info' | 'success' | 'warning' | 'error';

/** Shape for inserting into auto_trade_events (auto-trader side) */
export interface AutoTradeEventInput {
  ticker: string;
  event_type?: AutoTradeEventType;
  message: string;
  action?: AutoTradeAction;
  source?: AutoTradeSource;
  mode?: TradeMode;
  scanner_signal?: string | null;
  scanner_confidence?: number | null;
  fa_recommendation?: string | null;
  fa_confidence?: number | null;
  skip_reason?: string | null;
  strategy_source?: string | null;
  strategy_source_url?: string | null;
  strategy_video_id?: string | null;
  strategy_video_heading?: string | null;
  metadata?: Record<string, unknown>;
  candle_patterns?: string[];
  [key: string]: unknown;
}

/** Shape for reading from auto_trade_events (frontend/consumer side) */
export interface AutoTradeEventRecord {
  id: string;
  ticker: string;
  event_type: AutoTradeEventType;
  action: AutoTradeAction | null;
  source: AutoTradeSource | null;
  mode: TradeMode | null;
  message: string;
  strategy_source: string | null;
  strategy_source_url: string | null;
  strategy_video_id: string | null;
  strategy_video_heading: string | null;
  scanner_signal: string | null;
  scanner_confidence: number | null;
  fa_recommendation: string | null;
  fa_confidence: number | null;
  skip_reason: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}
