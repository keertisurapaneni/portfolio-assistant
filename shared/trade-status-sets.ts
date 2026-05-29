/**
 * Shared trade status sets — Single Source of Truth
 *
 * Canonical arrays for filtering paper_trades by lifecycle stage.
 * Use these instead of inline ['PENDING', 'SUBMITTED', ...] arrays.
 * Imported by: auto-trader, frontend app, edge functions.
 */

import type { TradeStatus, TradeMode } from './trade-types.js';

/** Trades that are open / in-flight (not yet resolved) */
export const ACTIVE_STATUSES: readonly TradeStatus[] = [
  'PENDING', 'SUBMITTED', 'FILLED', 'PARTIAL',
] as const;

/** Trades that reached a terminal state with a fill (for P&L calculation) */
export const CLOSED_STATUSES: readonly TradeStatus[] = [
  'STOPPED', 'TARGET_HIT', 'CLOSED',
] as const;

/** Trades that never executed — exclude from performance metrics */
export const EXCLUDED_STATUSES: readonly TradeStatus[] = [
  'CANCELLED', 'REJECTED',
] as const;

/**
 * All terminal statuses (closed + excluded) — useful for "is this trade done?"
 * Includes CANCELLED/REJECTED so UI can show them as resolved.
 */
export const ALL_TERMINAL_STATUSES: readonly TradeStatus[] = [
  ...CLOSED_STATUSES, ...EXCLUDED_STATUSES,
] as const;

/** Equity trade modes (excludes options and earnings) */
export const EQUITY_MODES: readonly TradeMode[] = [
  'DAY_TRADE', 'DAY_PENNY', 'SWING_TRADE', 'LONG_TERM',
] as const;

/** Options trade modes */
export const OPTIONS_MODES: readonly TradeMode[] = [
  'OPTIONS_PUT', 'OPTIONS_CALL', 'OPTIONS_SCALP', 'OPTIONS_LEAP',
] as const;
