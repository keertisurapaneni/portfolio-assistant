/**
 * Paper Trades API — Supabase CRUD for the paper_trades, trade_learnings,
 * and trade_performance tables.
 */

import { supabase } from './supabaseClient';
import { getExemptFromAutoDeactivationSources } from './strategyVideosApi';

import type { PaperTrade, TradeStatus, CloseReason, TradeMode, AccountType } from '../../../shared/trade-types.ts';
export type { PaperTrade, TradeStatus, CloseReason, TradeMode, AccountType };

import type { AccountView } from '../contexts/AccountContext';
export type { AccountView };

import type { AutoTradeEventRecord, AutoTradeAction, AutoTradeSource } from '../../../shared/auto-trade-events.ts';
export type { AutoTradeEventRecord, AutoTradeAction, AutoTradeSource };

import {
  ACTIVE_STATUSES,
  CLOSED_STATUSES,
  EXCLUDED_STATUSES,
  ALL_TERMINAL_STATUSES,
} from '../../../shared/trade-status-sets.ts';

// ── Account-aware table resolvers ────────────────────────

function tradesTableName(view: AccountView): 'paper_trades' | 'live_trades' {
  return view === 'live' ? 'live_trades' : 'paper_trades';
}

function eventsTableName(view: AccountView): 'auto_trade_events' | 'live_trade_events' {
  return view === 'live' ? 'live_trade_events' : 'auto_trade_events';
}

// Extended trade type with optional account indicator (used in 'all' view)
export type PaperTradeWithAccount = PaperTrade & { _accountType?: AccountType };

// ── Shared cache: dedup parallel paper_trades fetches ────
// The recalculate*() functions all query paper_trades independently.
// This cache ensures only one round-trip happens when they run in parallel.

let _sharedTradesInflight: Promise<PaperTrade[]> | null = null;
let _sharedTradesCache: { data: PaperTrade[]; ts: number } | null = null;

let _exemptInflight: Promise<Set<string>> | null = null;
let _exemptCache: { data: Set<string>; ts: number } | null = null;

const SHARED_CACHE_TTL = 30_000;

async function getSharedTrades(accountView: AccountView = 'paper'): Promise<PaperTradeWithAccount[]> {
  if (accountView === 'live') {
    const { data, error } = await supabase.from('live_trades').select('*').limit(2000);
    if (error) throw new Error(`Failed to fetch live trades: ${error.message}`);
    return (data ?? []) as PaperTradeWithAccount[];
  }

  // Paper (default) — use the cache
  if (_sharedTradesCache && Date.now() - _sharedTradesCache.ts < SHARED_CACHE_TTL) {
    return _sharedTradesCache.data;
  }
  if (_sharedTradesInflight) return _sharedTradesInflight;
  _sharedTradesInflight = (async () => {
    const { data, error } = await supabase
      .from('paper_trades')
      .select('*')
      .limit(2000);
    _sharedTradesInflight = null;
    if (error) throw new Error(`Failed to fetch trades: ${error.message}`);
    const trades = (data ?? []) as PaperTrade[];
    _sharedTradesCache = { data: trades, ts: Date.now() };
    return trades;
  })();
  return _sharedTradesInflight;
}

async function getCachedExemptSources(): Promise<Set<string>> {
  if (_exemptCache && Date.now() - _exemptCache.ts < SHARED_CACHE_TTL * 2) {
    return _exemptCache.data;
  }
  if (_exemptInflight) return _exemptInflight;
  _exemptInflight = (async () => {
    const result = await getExemptFromAutoDeactivationSources();
    _exemptInflight = null;
    _exemptCache = { data: result, ts: Date.now() };
    return result;
  })();
  return _exemptInflight;
}

export function clearSharedTradesCache(): void {
  _sharedTradesCache = null;
  _sharedTradesInflight = null;
  _exemptCache = null;
  _exemptInflight = null;
}

// ── Types ────────────────────────────────────────────────
// PaperTrade, TradeStatus, CloseReason, TradeMode imported from shared/trade-types.ts above.

export interface TradeLearning {
  id: string;
  trade_id: string;
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'PENDING';
  lesson: string | null;
  what_worked: string | null;
  what_failed: string | null;
  market_context: string | null;
  created_at: string;
}

export interface TradePerformance {
  id: string;
  total_trades: number;
  wins: number;
  losses: number;
  breakevens: number;
  win_rate: number;
  avg_pnl: number;
  avg_win: number;
  avg_loss: number;
  total_pnl: number;
  best_trade_pnl: number;
  worst_trade_pnl: number;
  common_win_patterns: string[];
  common_loss_patterns: string[];
  ai_summary: string | null;
  updated_at: string;
}

// ── Paper Trades CRUD ────────────────────────────────────

/** Create a new paper trade record */
export async function createPaperTrade(trade: Partial<PaperTrade>): Promise<PaperTrade> {
  const { data, error } = await supabase
    .from('paper_trades')
    .insert(trade)
    .select()
    .single();

  if (error) throw new Error(`Failed to create trade: ${error.message}`);
  return data as PaperTrade;
}

/** Update a paper trade */
export async function updatePaperTrade(
  id: string,
  updates: Partial<PaperTrade>
): Promise<PaperTrade> {
  const { data, error } = await supabase
    .from('paper_trades')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw new Error(`Failed to update trade: ${error.message}`);
  return data as PaperTrade;
}

/** Delete a paper trade by ID */
export async function deletePaperTrade(id: string): Promise<void> {
  const { error } = await supabase
    .from('paper_trades')
    .delete()
    .eq('id', id);

  if (error) throw new Error(`Failed to delete trade: ${error.message}`);
}

/** Delete paper trades by status */
export async function deletePaperTradesByStatus(status: TradeStatus): Promise<number> {
  const { data, error } = await supabase
    .from('paper_trades')
    .delete()
    .eq('status', status)
    .select('id');

  if (error) throw new Error(`Failed to delete trades: ${error.message}`);
  return data?.length ?? 0;
}

/** Get active trades (not yet closed) */
export async function getActiveTrades(): Promise<PaperTrade[]> {
  const { data, error } = await supabase
    .from('paper_trades')
    .select('*')
    .in('status', [...ACTIVE_STATUSES])
    .order('opened_at', { ascending: false });

  if (error) throw new Error(`Failed to fetch active trades: ${error.message}`);
  return (data ?? []) as PaperTrade[];
}

/** Get closed trade P&L time series (lightweight — just dates and P&L) */
export async function getClosedTradePnlSeries(accountView: AccountView = 'paper'): Promise<Array<{date: string; pnl: number}>> {
  const table = tradesTableName(accountView);
  const { data } = await supabase
    .from(table)
    .select('closed_at, pnl')
    .not('pnl', 'is', null)
    .not('closed_at', 'is', null)
    .in('status', ['TARGET_HIT', 'STOPPED', 'CLOSED'])
    .order('closed_at', { ascending: true });
  return (data ?? []).map(t => ({ date: t.closed_at, pnl: t.pnl }));
}

/** Get all trades (most recent first) */
export async function getAllTrades(limit = 50, accountView: AccountView = 'paper'): Promise<PaperTradeWithAccount[]> {
  const table = tradesTableName(accountView);
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .order('opened_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to fetch trades: ${error.message}`);
  return (data ?? []) as PaperTradeWithAccount[];
}

/**
 * Get today's trades from paper_trades directly (IB fills as source of truth).
 * Returns all trades opened or closed today, ordered newest first.
 * P&L comes from paper_trades.pnl which is kept accurate by the Postgres trigger
 * on ib_fills (sync_ib_fill_to_paper_trades).
 */
export async function getTodayTrades(accountView: AccountView = 'paper'): Promise<PaperTradeWithAccount[]> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  // Look back 7 days to catch stale day trades the EOD sweep missed.
  const lookbackStart = new Date(todayStart);
  lookbackStart.setDate(lookbackStart.getDate() - 7);
  const lookbackISO = lookbackStart.toISOString();

  async function fetchForTable(table: 'paper_trades' | 'live_trades', acct?: AccountType): Promise<PaperTradeWithAccount[]> {
    // Fetch today's traded rows (opened or closed today) PLUS any still-open
    // (FILLED/PARTIAL) day trades from the past 7 days. These are stale positions
    // the EOD sweep missed — they belong in today's activity because the auto-trader
    // is actively trying to close them today.
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .or(
        `opened_at.gte.${todayISO},` +
        `closed_at.gte.${todayISO},` +
        `and(status.in.(FILLED,PARTIAL),mode.in.(DAY_TRADE,DAY_PENNY),filled_at.gte.${lookbackISO})`
      )
      // Exclude ib_reconciliation_cover (pnl=0 cover buys — P&L flows via auto_trade_events).
      // Exclude stale_eod_close (historical cleanups of old positions — IB settled them long
      // ago; they don't appear in IB's today realized P&L and cause a calc/IB mismatch).
      // Each filter uses OR IS NULL — plain .neq() drops NULL close_reason rows too
      // because SQL NULL != x evaluates to UNKNOWN, not TRUE.
      .or('close_reason.neq.ib_reconciliation_cover,close_reason.is.null')
      .or('close_reason.neq.stale_eod_close,close_reason.is.null')
      .order('opened_at', { ascending: false });

    if (error) return [];
    const rows = (data ?? []) as PaperTrade[];
    // Deduplicate by id in case any row matches multiple OR conditions
    const seen = new Set<string>();
    const deduped = rows.filter(r => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
    if (acct) return deduped.map(t => ({ ...t, _accountType: acct }));
    return deduped;
  }

  if (accountView === 'live') return fetchForTable('live_trades', 'live');
  return fetchForTable('paper_trades');
}

// ── Orphaned IB fills (no paper_trade) ───────────────────────────────────────
//
// Every IB execution lands in ib_fills immediately via the execDetails callback.
// paper_trades should be fully in sync, but edge cases (reconcile loops, delayed
// commission reports, IB restart race conditions) can leave fills with no matching
// paper_trade. This function finds those gaps so the UI can show them even when
// the tracking DB is incomplete.

export interface OrphanedFill {
  /** Synthetic row key */
  _id: string;
  ticker: string;
  order_id: number;
  side: 'BOT' | 'SLD';
  total_quantity: number;
  avg_fill_price: number;
  realized_pnl: number | null;
  filled_at: string;
}

export async function getTodaysOrphanedFills(
  accountView: AccountView = 'paper',
  knownOrderIds: Set<string> = new Set(),
): Promise<OrphanedFill[]> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const fillsTable = accountView === 'live' ? 'live_ib_fills' : 'ib_fills';

  const { data: fills, error } = await supabase
    .from(fillsTable)
    .select('order_id, ticker, side, quantity, fill_price, realized_pnl, filled_at')
    .gte('filled_at', todayStart.toISOString())
    .not('ticker', 'is', null)
    .neq('ticker', '');

  if (error || !fills || fills.length === 0) return [];

  // Group by (order_id, ticker, side)
  const groups = new Map<string, typeof fills>();
  for (const fill of fills) {
    const key = `${fill.order_id}:${fill.ticker}:${fill.side}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(fill);
  }

  // knownOrderIds is built from todayTradesResult (trades opened/closed today).
  // But LONG_TERM/SWING positions opened before today can be partially closed today —
  // their ib_close_order_id won't be in todayTradesResult. Do a targeted DB lookup
  // for any fill order_id that matches an ib_close_order_id on any paper_trade.
  const uncoveredIds = [...groups.keys()]
    .map(k => String(groups.get(k)![0].order_id))
    .filter(id => !knownOrderIds.has(id));

  if (uncoveredIds.length > 0) {
    const tradesTable = accountView === 'live' ? 'live_trades' : 'paper_trades';
    const { data: closeMatches } = await supabase
      .from(tradesTable)
      .select('ib_close_order_id')
      .in('ib_close_order_id', uncoveredIds)
      .not('ib_close_order_id', 'is', null);
    (closeMatches ?? []).forEach(t => {
      if (t.ib_close_order_id) knownOrderIds.add(t.ib_close_order_id);
    });
  }

  const orphans: OrphanedFill[] = [];
  for (const [, fillGroup] of groups) {
    const first = fillGroup[0];
    const orderIdStr = String(first.order_id);

    // Skip if this order is already covered by a paper_trade
    if (knownOrderIds.has(orderIdStr)) continue;

    const realizedPnl = fillGroup.some(f => f.realized_pnl != null)
      ? fillGroup.reduce((s, f) => s + (Number(f.realized_pnl) || 0), 0)
      : null;

    // Surface closing fills that carry realized P&L:
    // - SLD: selling to close a long (stocks / long options)
    // - BOT with realized_pnl: buying to close a short (short puts/calls)
    // Opening BOT fills (realized_pnl null) stay hidden — they are not "today's activity" closes.
    const isClosingFill =
      first.side === 'SLD' || (first.side === 'BOT' && realizedPnl != null);
    if (!isClosingFill) continue;

    const totalQty = fillGroup.reduce((s, f) => s + Number(f.quantity), 0);
    const totalValue = fillGroup.reduce((s, f) => s + Number(f.quantity) * Number(f.fill_price), 0);
    const avgFillPrice = totalQty > 0 ? totalValue / totalQty : 0;

    orphans.push({
      _id: `orphan:${first.order_id}:${first.ticker}`,
      ticker: first.ticker,
      order_id: Number(first.order_id),
      side: first.side === 'BOT' ? 'BOT' : 'SLD',
      total_quantity: totalQty,
      avg_fill_price: avgFillPrice,
      realized_pnl: realizedPnl != null ? parseFloat(realizedPnl.toFixed(2)) : null,
      filled_at: first.filled_at,
    });
  }

  return orphans;
}

/** Day trade validation report — answers: trend vs chop? confidence ≥7 predictive? */
export interface DayTradeValidationReport {
  trendVsChop: Array<{
    marketCondition: string;
    trades: number;
    wins: number;
    winRatePct: number;
    avgPnl: number;
    avgRMultiple: number;
  }>;
  confidence7Plus: Array<{
    confBucket: string;
    trades: number;
    wins: number;
    winRatePct: number;
    avgRMultiple: number;
  }>;
  inPlayScoreBuckets: Array<{
    bucket: string;
    trades: number;
    avgRMultiple: number;
    winRatePct: number;
  }>;
  recentTrades: Array<{
    ticker: string;
    signal: string;
    openedAt: string;
    inPlayScore: number | null;
    pass1Confidence: number | null;
    pass2Confidence: number | null;
    entryTriggerType: string | null;
    rMultiple: number | null;
    pnl: number | null;
    pnlPercent: number | null;
    closeReason: string | null;
    marketCondition: string | null;
  }>;
}

export async function getDayTradeValidationReport(): Promise<DayTradeValidationReport> {
  const { data, error } = await supabase
    .from('paper_trades')
    .select('*')
    .in('mode', ['DAY_TRADE', 'DAY_PENNY'])
    .not('closed_at', 'is', null)
    .order('opened_at', { ascending: false })
    .limit(100);

  if (error) throw new Error(`Failed to fetch day trades: ${error.message}`);
  const trades = (data ?? []) as PaperTrade[];

  // Exclude zero-P&L ghost trades: positions that technically have a fill_price recorded
  // but closed with essentially $0 P&L (cancelled before real execution, ACTIVE-status ghosts,
  // or EOD-closed no-fill orders). These are not real executed trades and skew win rate.
  const scannerTrades = trades.filter(t =>
    t.entry_trigger_type === 'bracket_limit' &&
    t.fill_price != null &&
    t.pnl != null &&
    Math.abs(t.pnl) > 0.10
  );
  const withMarket = scannerTrades.filter(t => t.market_condition);

  const trendVsChop = ['trend', 'chop'].map(mc => {
    const subset = withMarket.filter(t => t.market_condition === mc);
    const wins = subset.filter(t => t.pnl! > 0).length;
    const rMults = subset.map(t => t.r_multiple).filter((r): r is number => r != null);
    return {
      marketCondition: mc,
      trades: subset.length,
      wins,
      winRatePct: subset.length > 0 ? Math.round(100 * wins / subset.length) : 0,
      avgPnl: subset.length > 0 ? Math.round(100 * subset.reduce((s, t) => s + t.pnl!, 0) / subset.length) / 100 : 0,
      avgRMultiple: rMults.length > 0 ? Math.round(100 * rMults.reduce((a, b) => a + b, 0) / rMults.length) / 100 : 0,
    };
  }).filter(r => r.trades > 0);

  const conf7Plus = scannerTrades.filter(t => (t.fa_confidence ?? 0) >= 7);
  const confBelow7 = scannerTrades.filter(t => (t.fa_confidence ?? 0) < 7);
  const confidence7Plus = [
    { subset: conf7Plus, label: 'conf ≥7' },
    { subset: confBelow7, label: 'conf <7' },
  ].map(({ subset, label }) => {
    const wins = subset.filter(t => t.pnl! > 0).length;
    const rMults = subset.map(t => t.r_multiple).filter((r): r is number => r != null);
    return {
      confBucket: label,
      trades: subset.length,
      wins,
      winRatePct: subset.length > 0 ? Math.round(100 * wins / subset.length) : 0,
      avgRMultiple: rMults.length > 0 ? Math.round(100 * rMults.reduce((a, b) => a + b, 0) / rMults.length) / 100 : 0,
    };
  }).filter(r => r.trades > 0);

  const highInPlay = scannerTrades.filter(t => (t.in_play_score ?? 0) >= 2.5);
  const midInPlay = scannerTrades.filter(t => (t.in_play_score ?? 0) >= 1.5 && (t.in_play_score ?? 0) < 2.5);
  const lowInPlay = scannerTrades.filter(t => (t.in_play_score ?? 0) < 1.5 && t.in_play_score != null);
  const inPlayScoreBuckets = [
    { subset: highInPlay, label: 'high (≥2.5)' },
    { subset: midInPlay, label: 'mid (1.5–2.5)' },
    { subset: lowInPlay, label: 'low (<1.5)' },
  ].map(({ subset, label }) => {
    const wins = subset.filter(t => t.pnl! > 0).length;
    const rMults = subset.map(t => t.r_multiple).filter((r): r is number => r != null);
    return {
      bucket: label,
      trades: subset.length,
      avgRMultiple: rMults.length > 0 ? Math.round(100 * rMults.reduce((a, b) => a + b, 0) / rMults.length) / 100 : 0,
      winRatePct: subset.length > 0 ? Math.round(100 * wins / subset.length) : 0,
    };
  }).filter(r => r.trades > 0);

  const recentTrades = scannerTrades.slice(0, 30).map(t => ({
    ticker: t.ticker,
    signal: t.signal,
    openedAt: t.opened_at ?? t.created_at ?? '',
    inPlayScore: t.in_play_score ?? null,
    pass1Confidence: t.pass1_confidence ?? null,
    pass2Confidence: t.fa_confidence ?? null,
    entryTriggerType: t.entry_trigger_type ?? null,
    rMultiple: t.r_multiple ?? null,
    pnl: t.pnl ?? null,
    pnlPercent: t.pnl_percent ?? null,
    closeReason: t.close_reason ?? null,
    marketCondition: t.market_condition ?? null,
  }));

  return { trendVsChop, confidence7Plus, inPlayScoreBuckets, recentTrades };
}

/** Swing trade validation report — funnel metrics + diagnostics (same as day trade) */
export interface SwingTradeValidationReport {
  funnel: {
    signals: number;
    confident: number;
    skippedDistance: number;
    ordersPlaced: number;
    ordersExpired: number;
    ordersFilled: number;
    signalsPerWeek: number;
  };
  trendVsChop: Array<{
    marketCondition: string;
    trades: number;
    wins: number;
    winRatePct: number;
    avgPnl: number;
  }>;
  closeReason: Array<{
    reason: string;
    trades: number;
    totalPnl: number;
    avgDaysHeld: number;
  }>;
  quickStops: { count: number; pnl: number; pctOfLosses: number };
  fillRate: number;
  verdict: string;
  recentTrades: Array<{
    ticker: string;
    signal: string;
    filledAt: string;
    closedAt: string | null;
    pnl: number | null;
    closeReason: string | null;
    marketCondition: string | null;
  }>;
}

export async function getSwingTradeValidationReport(): Promise<SwingTradeValidationReport> {
  const twentyOneDaysAgo = new Date();
  twentyOneDaysAgo.setDate(twentyOneDaysAgo.getDate() - 21);
  const fromDate = twentyOneDaysAgo.toISOString().slice(0, 10);

  const [metricsRes, tradesRes] = await Promise.all([
    supabase.from('swing_trade_metrics').select('*').gte('date', fromDate).order('date', { ascending: false }),
    supabase.from('paper_trades').select('*').eq('mode', 'SWING_TRADE').order('opened_at', { ascending: false }).limit(100),
  ]);

  const metrics = (metricsRes.data ?? []) as Array<{
    date: string;
    swing_signals: number;
    swing_confident: number;
    swing_skipped_distance: number;
    swing_orders_placed: number;
    swing_orders_expired: number;
    swing_orders_filled: number;
  }>;
  const trades = (tradesRes.data ?? []) as PaperTrade[];

  const funnel = {
    signals: metrics.reduce((s, m) => s + (m.swing_signals ?? 0), 0),
    confident: metrics.reduce((s, m) => s + (m.swing_confident ?? 0), 0),
    skippedDistance: metrics.reduce((s, m) => s + (m.swing_skipped_distance ?? 0), 0),
    ordersPlaced: metrics.reduce((s, m) => s + (m.swing_orders_placed ?? 0), 0),
    ordersExpired: metrics.reduce((s, m) => s + (m.swing_orders_expired ?? 0), 0),
    ordersFilled: metrics.reduce((s, m) => s + (m.swing_orders_filled ?? 0), 0),
    signalsPerWeek: 0,
  };
  const days = metrics.length;
  funnel.signalsPerWeek = days >= 1 ? Math.round((funnel.signals / days) * 5) : 0; // ~5 trading days/week

  const closed = trades.filter(
    t => t.fill_price != null && t.pnl != null && (CLOSED_STATUSES as readonly string[]).includes(t.status)
  );
  const bracketOrders = trades.filter(t => t.entry_trigger_type === 'bracket_limit');
  const filled = bracketOrders.filter(t => t.fill_price != null);
  const fillRate = bracketOrders.length > 0 ? Math.round(100 * filled.length / bracketOrders.length) : 0;

  const byRegime = new Map<string, { trades: number; wins: number; pnl: number }>();
  for (const t of closed) {
    const mc = t.market_condition ?? 'unknown';
    const cur = byRegime.get(mc) ?? { trades: 0, wins: 0, pnl: 0 };
    cur.trades++;
    if (t.pnl! > 0) cur.wins++;
    cur.pnl += t.pnl!;
    byRegime.set(mc, cur);
  }
  const trendVsChop = [...byRegime.entries()].map(([mc, s]) => ({
    marketCondition: mc,
    trades: s.trades,
    wins: s.wins,
    winRatePct: s.trades > 0 ? Math.round(100 * s.wins / s.trades) : 0,
    avgPnl: s.trades > 0 ? Math.round(100 * s.pnl / s.trades) / 100 : 0,
  }));

  const byReason = new Map<string, { trades: number; pnl: number; daysHeld: number[] }>();
  for (const t of closed) {
    const r = t.close_reason ?? 'unknown';
    const cur = byReason.get(r) ?? { trades: 0, pnl: 0, daysHeld: [] };
    cur.trades++;
    cur.pnl += t.pnl!;
    if (t.filled_at && t.closed_at) {
      cur.daysHeld.push((new Date(t.closed_at).getTime() - new Date(t.filled_at).getTime()) / 86400000);
    }
    byReason.set(r, cur);
  }
  const closeReason = [...byReason.entries()].map(([r, s]) => ({
    reason: r,
    trades: s.trades,
    totalPnl: Math.round(100 * s.pnl) / 100,
    avgDaysHeld: s.daysHeld.length > 0
      ? Math.round(10 * s.daysHeld.reduce((a, b) => a + b, 0) / s.daysHeld.length) / 10
      : 0,
  }));

  const quickStops = closed.filter(t => {
    if (t.close_reason !== 'stop_loss' || !t.filled_at || !t.closed_at) return false;
    const days = (new Date(t.closed_at).getTime() - new Date(t.filled_at).getTime()) / 86400000;
    return days < 2;
  });
  const totalLosses = closed.filter(t => t.pnl! < 0);
  const totalLossPnl = totalLosses.reduce((s, t) => s + t.pnl!, 0);
  const quickStopPnl = quickStops.reduce((s, t) => s + t.pnl!, 0);
  const pctOfLosses = totalLosses.length > 0 && totalLossPnl !== 0
    ? Math.round(100 * quickStopPnl / totalLossPnl)
    : 0;

  let verdict = 'Need more data (fewer than 5 closed swing trades)';
  const chop = byRegime.get('chop');
  const trend = byRegime.get('trend');
  if (chop && trend && chop.trades >= 3 && chop.pnl < trend.pnl - 50) {
    verdict = 'A) Regime refinement (chop underperforming)';
  } else if (quickStops.length >= totalLosses.length * 0.5 && totalLosses.length >= 2) {
    verdict = 'C) Pullback quality refinement (quick failures)';
  } else if (filled.length < bracketOrders.length * 0.5 && bracketOrders.length >= 5) {
    verdict = 'E) Execution refinement (low fill rate)';
  } else if (closed.length >= 5) {
    verdict = 'Run full analysis; no single dominant pattern yet.';
  }

  const recentTrades = closed.slice(0, 20).map(t => ({
    ticker: t.ticker,
    signal: t.signal,
    filledAt: t.filled_at ?? t.opened_at ?? '',
    closedAt: t.closed_at ?? null,
    pnl: t.pnl ?? null,
    closeReason: t.close_reason ?? null,
    marketCondition: t.market_condition ?? null,
  }));

  return {
    funnel,
    trendVsChop,
    closeReason,
    quickStops: { count: quickStops.length, pnl: Math.round(100 * quickStopPnl) / 100, pctOfLosses },
    fillRate,
    verdict,
    recentTrades,
  };
}

/** Get completed trades for a specific ticker */
export async function getTradesByTicker(ticker: string): Promise<PaperTrade[]> {
  const { data, error } = await supabase
    .from('paper_trades')
    .select('*')
    .eq('ticker', ticker)
    .order('opened_at', { ascending: false });

  if (error) throw new Error(`Failed to fetch trades for ${ticker}: ${error.message}`);
  return (data ?? []) as PaperTrade[];
}

/** Check if there's already an active trade for a ticker */
export async function hasActiveTrade(ticker: string): Promise<boolean> {
  const { count, error } = await supabase
    .from('paper_trades')
    .select('id', { count: 'exact', head: true })
    .eq('ticker', ticker)
    .in('status', [...ACTIVE_STATUSES]);

  if (error) return false;
  return (count ?? 0) > 0;
}

/** Count active positions */
export async function countActivePositions(): Promise<number> {
  const { count, error } = await supabase
    .from('paper_trades')
    .select('id', { count: 'exact', head: true })
    .in('status', [...ACTIVE_STATUSES]);

  if (error) return 0;
  return count ?? 0;
}

// ── Trade Learnings ──────────────────────────────────────

/** Record a learning from a completed trade */
export async function createTradeLearning(learning: Partial<TradeLearning>): Promise<TradeLearning> {
  const { data, error } = await supabase
    .from('trade_learnings')
    .insert(learning)
    .select()
    .single();

  if (error) throw new Error(`Failed to create learning: ${error.message}`);
  return data as TradeLearning;
}

/** Get recent learnings for AI feedback */
export async function getRecentLearnings(limit = 20): Promise<TradeLearning[]> {
  const { data, error } = await supabase
    .from('trade_learnings')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return [];
  return (data ?? []) as TradeLearning[];
}

// ── Auto Trade Events ────────────────────────────────────

// AutoTradeEventRecord, AutoTradeAction, AutoTradeSource imported from shared/auto-trade-events.ts above.

/** Persist an auto-trade event to Supabase */
export async function createAutoTradeEvent(
  event: Partial<AutoTradeEventRecord>
): Promise<void> {
  try {
    await supabase.from('auto_trade_events').insert(event);
  } catch {
    // Fire-and-forget — don't break auto-trading if logging fails
    console.warn('[AutoTradeEvents] Failed to persist event:', event.message);
  }
}

/** Get recent auto-trade events (most recent first) */
export type AutoTradeEventWithAccount = AutoTradeEventRecord & { _accountType?: AccountType };

export async function getAutoTradeEvents(limit = 100, accountView: AccountView = 'paper'): Promise<AutoTradeEventWithAccount[]> {
  const table = eventsTableName(accountView);
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return [];
  return (data ?? []) as AutoTradeEventWithAccount[];
}

/** Get today's executed events (all modes — day, swing, long-term, system closes) */
export async function getTodaysExecutedEvents(accountView: AccountView = 'paper'): Promise<AutoTradeEventWithAccount[]> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  async function fetchForTable(
    evTable: 'auto_trade_events' | 'live_trade_events',
    trTable: 'paper_trades' | 'live_trades',
    acct?: AccountType,
  ): Promise<AutoTradeEventWithAccount[]> {
    const [eventsRes, tradesRes] = await Promise.all([
      supabase.from(evTable).select('*')
        .in('action', ['executed', 'failed', 'closed'])
        .gte('created_at', todayISO)
        .order('created_at', { ascending: false }),
      supabase.from(trTable)
        .select('id, ticker, mode, signal, scanner_confidence, fa_confidence, fa_recommendation, strategy_source, strategy_source_url, strategy_video_id, strategy_video_heading, quantity, fill_price, status, opened_at, filled_at, scanner_signal')
        .in('status', ['FILLED', 'TARGET_HIT', 'STOPPED', 'CLOSED', 'PARTIAL'])
        .gte('opened_at', todayISO)
        .order('opened_at', { ascending: false }),
    ]);

    const events = ((eventsRes.data ?? []) as AutoTradeEventRecord[]).filter(
      e => e.action === 'executed' || e.action === 'closed' || e.source === 'system'
    );

    const eventTickers = new Set(
      events.filter(e => e.action === 'executed').map(e => e.ticker.toUpperCase())
    );

    const fallbackTrades = (tradesRes.data ?? []).filter(
      t => !eventTickers.has(t.ticker.toUpperCase())
    );

    const synthetic: AutoTradeEventRecord[] = fallbackTrades.map(t => ({
      id: `synth-${t.id}`,
      ticker: t.ticker,
      event_type: 'success' as const,
      action: 'executed' as const,
      source: 'scanner' as const,
      mode: t.mode as AutoTradeEventRecord['mode'],
      message: `${t.signal} ${t.quantity ?? '?'} @ $${(t.fill_price ?? 0).toFixed(2)}`,
      strategy_source: t.strategy_source ?? null,
      strategy_source_url: t.strategy_source_url ?? null,
      strategy_video_id: t.strategy_video_id ?? null,
      strategy_video_heading: t.strategy_video_heading ?? null,
      scanner_signal: t.scanner_signal ?? t.signal,
      scanner_confidence: t.scanner_confidence ?? null,
      fa_recommendation: t.fa_recommendation ?? null,
      fa_confidence: t.fa_confidence ?? null,
      skip_reason: null,
      metadata: { synthetic: true },
      created_at: t.filled_at ?? t.opened_at,
    }));

    const result = [...events, ...synthetic];
    if (acct) return result.map(e => ({ ...e, _accountType: acct }));
    return result;
  }

  const evTable = eventsTableName(accountView);
  const trTable = tradesTableName(accountView);
  return (await fetchForTable(evTable, trTable)).sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

/** Get auto-trade events for a specific ticker */
export async function getAutoTradeEventsByTicker(
  ticker: string,
  limit = 50,
  accountView: AccountView = 'paper',
): Promise<AutoTradeEventWithAccount[]> {
  if (accountView === 'live') {
    const { data, error } = await supabase.from('live_trade_events').select('*').eq('ticker', ticker).order('created_at', { ascending: false }).limit(limit);
    if (error) throw new Error(`Failed to fetch live events: ${error.message}`);
    return (data ?? []).map(e => ({ ...e, _accountType: 'live' as const })) as AutoTradeEventWithAccount[];
  }

  const table = eventsTableName(accountView);
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('ticker', ticker)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return [];
  return (data ?? []) as AutoTradeEventWithAccount[];
}

/** Get event stats for analysis — counts by action type */
export async function getAutoTradeEventStats(): Promise<{
  total: number;
  executed: number;
  skipped: number;
  failed: number;
  topSkipReasons: { reason: string; count: number }[];
  topMismatchTickers: { ticker: string; count: number }[];
}> {
  const { data, error } = await supabase
    .from('auto_trade_events')
    .select('action, skip_reason, ticker')
    .not('action', 'is', null);

  if (error || !data) return { total: 0, executed: 0, skipped: 0, failed: 0, topSkipReasons: [], topMismatchTickers: [] };

  const total = data.length;
  const executed = data.filter(e => e.action === 'executed').length;
  const skipped = data.filter(e => e.action === 'skipped').length;
  const failed = data.filter(e => e.action === 'failed').length;

  // Count skip reasons
  const reasonCounts: Record<string, number> = {};
  data.filter(e => e.action === 'skipped' && e.skip_reason).forEach(e => {
    reasonCounts[e.skip_reason!] = (reasonCounts[e.skip_reason!] ?? 0) + 1;
  });
  const topSkipReasons = Object.entries(reasonCounts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Count direction mismatch tickers
  const mismatchCounts: Record<string, number> = {};
  data.filter(e => e.skip_reason?.includes('Direction mismatch')).forEach(e => {
    mismatchCounts[e.ticker] = (mismatchCounts[e.ticker] ?? 0) + 1;
  });
  const topMismatchTickers = Object.entries(mismatchCounts)
    .map(([ticker, count]) => ({ ticker, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return { total, executed, skipped, failed, topSkipReasons, topMismatchTickers };
}

// ── Performance Stats ────────────────────────────────────

/** Get aggregate performance */
export async function getPerformance(): Promise<TradePerformance | null> {
  const { data, error } = await supabase
    .from('trade_performance')
    .select('*')
    .eq('id', 'global')
    .single();

  if (error) return null;
  return data as TradePerformance;
}

/** Update aggregate performance (recalculate from all trades) */
export async function recalculatePerformance(accountView: AccountView = 'paper'): Promise<TradePerformance | null> {
  const table = tradesTableName(accountView);
  const { data: trades, error } = await supabase
    .from(table)
    .select('*')
    .in('status', [...CLOSED_STATUSES]);

  if (error || !trades || trades.length === 0) return null;

  // Only count trades that actually filled AND have computed P&L
  // Trades with null pnl (legacy closes before recordTradeClose) are excluded
  const completed = (trades as PaperTrade[]).filter(t => t.fill_price != null && t.pnl != null);
  const wins = completed.filter(t => t.pnl! > 0);
  const losses = completed.filter(t => t.pnl! < 0);
  const breakevens = completed.filter(t => t.pnl === 0);

  const totalPnl = completed.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const avgPnl = completed.length > 0 ? totalPnl / completed.length : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length : 0;
  const bestPnl = Math.max(...completed.map(t => t.pnl ?? 0), 0);
  const worstPnl = Math.min(...completed.map(t => t.pnl ?? 0), 0);

  const stats: Partial<TradePerformance> = {
    total_trades: completed.length,
    wins: wins.length,
    losses: losses.length,
    breakevens: breakevens.length,
    win_rate: completed.length > 0 ? (wins.length / completed.length) * 100 : 0,
    avg_pnl: avgPnl,
    avg_win: avgWin,
    avg_loss: avgLoss,
    total_pnl: totalPnl,
    best_trade_pnl: bestPnl,
    worst_trade_pnl: worstPnl,
    updated_at: new Date().toISOString(),
  };

  const { data: updated, error: updateErr } = await supabase
    .from('trade_performance')
    .update(stats)
    .eq('id', 'global')
    .select()
    .single();

  if (updateErr) return null;
  return updated as TradePerformance;
}

// ── Category Performance (Signal Quality) ────────────────

export interface CategoryPerformance {
  category: 'suggested_finds' | 'day_trade' | 'scanner_day_trade' | 'influencer_day_trade' | 'day_penny' | 'swing_trade' | 'options_wheel' | 'dip_buy' | 'profit_take';
  totalTrades: number;
  activeTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Realized P&L from closed trades only */
  realizedPnl: number;
  /** Unrealized P&L from active/open positions */
  unrealizedPnl: number;
  /** realizedPnl + unrealizedPnl — kept for backward compat */
  totalPnl: number;
  avgPnl: number;
  avgReturnPct: number;
  bestTrade: { ticker: string; pnl: number; isOpen?: boolean } | null;
  worstTrade: { ticker: string; pnl: number; isOpen?: boolean } | null;
  totalDeployed: number;
}

export interface StrategySourcePerformance {
  source: string;
  sourceUrl: string | null;
  totalTrades: number;
  activeTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  consecutiveLosses: number;
  isMarkedX: boolean;
  exemptFromAutoDeactivation: boolean;
}

export interface StrategyVideoPerformance {
  source: string;
  sourceUrl: string | null;
  videoId: string | null;
  videoHeading: string;
  totalTrades: number;
  activeTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  avgReturnPct: number;
  consecutiveLosses: number;
  isMarkedX: boolean;
  firstTradeAt: string | null;
  lastTradeAt: string | null;
  recentTrades: Array<{
    ticker: string;
    signal: 'BUY' | 'SELL';
    openedAt: string | null;
    pnl: number | null;
    pnlPercent: number | null;
    status: TradeStatus;
  }>;
}

export interface StrategySignalStatusSummary {
  source: string;
  sourceUrl: string | null;
  videoId: string | null;
  videoHeading: string | null;
  platform: 'instagram' | 'twitter' | 'youtube' | null;
  strategyType: 'daily_signal' | 'daily_penny' | 'generic_strategy' | 'options_signal' | null;
  applicableDate: string | null;
  /** For generic_strategy: DAY_TRADE, SWING_TRADE, or both */
  applicableTimeframes: Array<'DAY_TRADE' | 'SWING_TRADE'> | null;
  latestSignalStatus: string | null;
  transcript?: string | null;
  ingestStatus?: 'pending' | 'transcribing' | 'done' | 'failed' | null;
  ingestError?: string | null;
}

export interface PendingStrategySignal {
  id: string;
  ticker: string;
  signal: 'BUY' | 'SELL';
  mode: 'DAY_TRADE' | 'DAY_PENNY' | 'SWING_TRADE' | 'LONG_TERM' | 'OPTIONS_PUT' | 'OPTIONS_CALL';
  source_name: string;
  source_url: string | null;
  strategy_video_id: string | null;
  strategy_video_heading: string | null;
  entry_price: number | null;
  execute_on_date: string;
  status: string;
  failure_reason: string | null;
  created_at: string;
}

/**
 * Recalculate performance broken down by category:
 * - suggested_finds: LONG_TERM mode trades (initial picks only, not dip_buy/profit_take)
 * - day_trade: DAY_TRADE mode scanner trades
 * - swing_trade: SWING_TRADE mode scanner trades
 * - dip_buy: dip buy add-ons (portfolio management)
 * - profit_take: profit take trims (portfolio management)
 */
export async function recalculatePerformanceByCategory(accountView: AccountView = 'paper'): Promise<CategoryPerformance[]> {
  let trades: PaperTrade[];
  try {
    trades = await getSharedTrades(accountView);
  } catch {
    return [];
  }

  const categories: Array<{
    key: CategoryPerformance['category'];
    filter: (t: PaperTrade) => boolean;
  }> = [
    {
      key: 'suggested_finds',
      filter: (t) => t.mode === 'LONG_TERM' && t.signal === 'BUY' &&
        !(t.notes ?? '').startsWith('Dip buy'),
    },
    {
      // Legacy combined bucket — kept for backward-compat but replaced by the two below
      key: 'day_trade',
      filter: (t) => t.mode === 'DAY_TRADE',
    },
    {
      // Our system's own AI signals: no influencer source, no strategy video
      key: 'scanner_day_trade',
      filter: (t) => t.mode === 'DAY_TRADE' && !t.strategy_video_id && !t.strategy_source,
    },
    {
      // External influencer signals: either from a strategy video (YouTube) or
      // a named influencer source (e.g. Somesh's Instagram bracket signals)
      key: 'influencer_day_trade',
      filter: (t) => t.mode === 'DAY_TRADE' && (!!t.strategy_video_id || !!t.strategy_source),
    },
    {
      key: 'day_penny',
      filter: (t) => t.mode === 'DAY_PENNY',
    },
    {
      key: 'swing_trade',
      filter: (t) => t.mode === 'SWING_TRADE',
    },
    {
      key: 'options_wheel',
      filter: (t) => t.mode === 'OPTIONS_PUT' || t.mode === 'OPTIONS_CALL' || t.mode === 'CREDIT_SPREAD',
    },
    {
      key: 'dip_buy',
      filter: (t) => (t.notes ?? '').startsWith('Dip buy'),
    },
    {
      key: 'profit_take',
      filter: (t) => (t.notes ?? '').startsWith('Profit take'),
    },
  ];

  const results: CategoryPerformance[] = [];

  for (const cat of categories) {
    const catTrades = trades.filter(cat.filter);
    const meaningful = catTrades.filter(t => !(EXCLUDED_STATUSES as readonly string[]).includes(t.status));

    const active = meaningful.filter(t => (ACTIVE_STATUSES as readonly string[]).includes(t.status));
    const completed = meaningful.filter(
      t => (CLOSED_STATUSES as readonly string[]).includes(t.status) && t.fill_price != null && t.pnl != null
    );
    const wins = completed.filter(t => t.pnl! > 0);
    const losses = completed.filter(t => t.pnl! < 0);

    const realizedPnl = completed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const avgPnl = completed.length > 0 ? realizedPnl / completed.length : 0;

    // Avg return %
    const returns = completed
      .filter(t => t.fill_price && t.quantity)
      .map(t => ((t.pnl ?? 0) / ((t.fill_price ?? 1) * (t.quantity ?? 1))) * 100);
    const avgReturnPct = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;

    // Unrealized P&L from active FILLED positions (live floating gains/losses)
    const filledActive = active.filter(t => t.status === 'FILLED' && t.pnl != null);
    const unrealizedPnl = filledActive.reduce((s, t) => s + (t.pnl ?? 0), 0);

    // Best/worst: include active FILLED positions so open losers like POOL show up
    const allForBestWorst = [
      ...completed.map(t => ({ ticker: t.ticker, pnl: t.pnl ?? 0, isOpen: false })),
      ...filledActive.map(t => ({ ticker: t.ticker, pnl: t.pnl ?? 0, isOpen: true })),
    ].sort((a, b) => b.pnl - a.pnl);
    const best = allForBestWorst[0] ?? null;
    const worst = allForBestWorst[allForBestWorst.length - 1] ?? null;

    const totalDeployed = active.reduce((s, t) => s + (t.position_size ?? 0), 0);

    results.push({
      category: cat.key,
      totalTrades: meaningful.length,
      activeTrades: active.length,
      wins: wins.length,
      losses: losses.length,
      winRate: completed.length > 0 ? (wins.length / completed.length) * 100 : 0,
      realizedPnl,
      unrealizedPnl,
      totalPnl: realizedPnl + unrealizedPnl,
      avgPnl,
      avgReturnPct,
      bestTrade: best,
      worstTrade: allForBestWorst.length > 0 ? worst : null,
      totalDeployed,
    });
  }

  return results;
}

export async function recalculatePerformanceByStrategySource(accountView: AccountView = 'paper'): Promise<StrategySourcePerformance[]> {
  let allTrades: PaperTrade[];
  let exemptSources: Set<string>;
  try {
    [allTrades, exemptSources] = await Promise.all([getSharedTrades(accountView), getCachedExemptSources()]);
  } catch {
    return [];
  }
  const trades = allTrades.filter(t => t.strategy_source != null);

  const activeStatusSet = new Set(ACTIVE_STATUSES);
  const closedStatusSet = new Set(CLOSED_STATUSES);

  const groups = new Map<string, {
    sourceUrl: string | null;
    totalTrades: number;
    activeTrades: number;
    wins: number;
    losses: number;
    closedCount: number;
    closedPnl: number;
    activeUnrealizedPnl: number;
    closedOutcomes: Array<{ pnl: number; at: string }>;
  }>();

  for (const trade of trades) {
    const source = (trade.strategy_source ?? '').trim();
    if (!source) continue;

    const curr = groups.get(source) ?? {
      sourceUrl: trade.strategy_source_url ?? null,
      totalTrades: 0,
      activeTrades: 0,
      wins: 0,
      losses: 0,
      closedCount: 0,
      closedPnl: 0,
      activeUnrealizedPnl: 0,
      closedOutcomes: [],
    };

    if (!curr.sourceUrl && trade.strategy_source_url) {
      curr.sourceUrl = trade.strategy_source_url;
    }

    curr.totalTrades += 1;
    if (activeStatusSet.has(trade.status)) {
      curr.activeTrades += 1;
      if (trade.status === 'FILLED' && trade.pnl != null) {
        curr.activeUnrealizedPnl += trade.pnl;
      }
    }

    if (closedStatusSet.has(trade.status) && trade.fill_price != null && trade.pnl != null) {
      curr.closedCount += 1;
      curr.closedPnl += trade.pnl;
      if (trade.pnl > 0) curr.wins += 1;
      if (trade.pnl < 0) curr.losses += 1;
      curr.closedOutcomes.push({
        pnl: trade.pnl,
        at: trade.closed_at ?? trade.opened_at ?? '',
      });
    }

    groups.set(source, curr);
  }

  return [...groups.entries()]
    .map(([source, s]) => {
      const sortedClosed = [...s.closedOutcomes].sort((a, b) => b.at.localeCompare(a.at));
      let consecutiveLosses = 0;
      let lossesOnSeparateDays = 0;
      let lastLossDate = '';
      for (const outcome of sortedClosed) {
        if (outcome.pnl < 0) {
          consecutiveLosses += 1;
          const day = (outcome.at || '').slice(0, 10);
          if (day && day !== lastLossDate) {
            lossesOnSeparateDays += 1;
            lastLossDate = day;
          }
        } else break;
      }
      const isExempt = exemptSources.has(source);
      const shouldDeactivate = lossesOnSeparateDays >= 3 && !isExempt;
      return {
        source,
        sourceUrl: s.sourceUrl,
        totalTrades: s.totalTrades,
        activeTrades: s.activeTrades,
        wins: s.wins,
        losses: s.losses,
        winRate: s.closedCount > 0 ? (s.wins / s.closedCount) * 100 : 0,
        totalPnl: s.closedPnl + s.activeUnrealizedPnl,
        avgPnl: s.closedCount > 0 ? s.closedPnl / s.closedCount : 0,
        consecutiveLosses,
        isMarkedX: shouldDeactivate,
        exemptFromAutoDeactivation: isExempt,
      };
    })
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

export async function recalculatePerformanceByStrategyVideo(accountView: AccountView = 'paper'): Promise<StrategyVideoPerformance[]> {
  let allTrades: PaperTrade[];
  let exemptSources: Set<string>;
  try {
    [allTrades, exemptSources] = await Promise.all([getSharedTrades(accountView), getCachedExemptSources()]);
  } catch {
    return [];
  }
  const trades = allTrades.filter(t => t.strategy_source != null);

  const activeStatusSet = new Set(ACTIVE_STATUSES);
  const closedStatusSet = new Set(CLOSED_STATUSES);

  const groups = new Map<string, {
    source: string;
    sourceUrl: string | null;
    videoId: string | null;
    videoHeading: string;
    totalTrades: number;
    activeTrades: number;
    wins: number;
    losses: number;
    closedCount: number;
    closedPnl: number;
    activeUnrealizedPnl: number;
    returns: number[];
    closedOutcomes: Array<{ pnl: number; at: string }>;
    firstTradeAt: string | null;
    lastTradeAt: string | null;
    recentTrades: Array<{
      ticker: string;
      signal: 'BUY' | 'SELL';
      openedAt: string | null;
      pnl: number | null;
      pnlPercent: number | null;
      status: TradeStatus;
    }>;
  }>();

  for (const trade of trades) {
    const source = (trade.strategy_source ?? '').trim();
    if (!source) continue;

    const videoId = (trade.strategy_video_id ?? '').trim() || null;
    const heading = (trade.strategy_video_heading ?? '').trim() || 'Legacy strategy (missing video metadata)';
    const key = `${source}::${videoId ?? heading}`;
    const curr = groups.get(key) ?? {
      source,
      sourceUrl: trade.strategy_source_url ?? null,
      videoId,
      videoHeading: heading,
      totalTrades: 0,
      activeTrades: 0,
      wins: 0,
      losses: 0,
      closedCount: 0,
      closedPnl: 0,
      activeUnrealizedPnl: 0,
      returns: [],
      closedOutcomes: [],
      firstTradeAt: trade.opened_at ?? null,
      lastTradeAt: trade.opened_at ?? null,
      recentTrades: [],
    };

    if (!curr.sourceUrl && trade.strategy_source_url) curr.sourceUrl = trade.strategy_source_url;
    if (!curr.videoId && videoId) curr.videoId = videoId;

    const openedAt = trade.opened_at ?? null;
    if (openedAt) {
      if (!curr.firstTradeAt || openedAt < curr.firstTradeAt) curr.firstTradeAt = openedAt;
      if (!curr.lastTradeAt || openedAt > curr.lastTradeAt) curr.lastTradeAt = openedAt;
    }

    curr.recentTrades.push({
      ticker: trade.ticker,
      signal: trade.signal,
      openedAt: trade.opened_at ?? null,
      pnl: trade.pnl ?? null,
      pnlPercent: trade.pnl_percent ?? null,
      status: trade.status,
    });

    curr.totalTrades += 1;
    if (activeStatusSet.has(trade.status)) {
      curr.activeTrades += 1;
      if (trade.status === 'FILLED' && trade.pnl != null) {
        curr.activeUnrealizedPnl += trade.pnl;
      }
    }

    if (closedStatusSet.has(trade.status) && trade.fill_price != null && trade.pnl != null) {
      curr.closedCount += 1;
      curr.closedPnl += trade.pnl;
      if (trade.pnl > 0) curr.wins += 1;
      if (trade.pnl < 0) curr.losses += 1;
      curr.closedOutcomes.push({
        pnl: trade.pnl,
        at: trade.closed_at ?? trade.opened_at ?? '',
      });
      if (trade.fill_price && trade.quantity) {
        curr.returns.push((trade.pnl / (trade.fill_price * trade.quantity)) * 100);
      }
    }

    groups.set(key, curr);
  }

  return [...groups.values()]
    .map(g => {
      const sortedClosed = [...g.closedOutcomes].sort((a, b) => b.at.localeCompare(a.at));
      let consecutiveLosses = 0;
      let lossesOnSeparateDays = 0;
      let lastLossDate = '';
      for (const outcome of sortedClosed) {
        if (outcome.pnl < 0) {
          consecutiveLosses += 1;
          const day = (outcome.at || '').slice(0, 10);
          if (day && day !== lastLossDate) {
            lossesOnSeparateDays += 1;
            lastLossDate = day;
          }
        } else break;
      }
      const shouldDeactivate = lossesOnSeparateDays >= 3 && !exemptSources.has(g.source);
      return {
        source: g.source,
        sourceUrl: g.sourceUrl,
        videoId: g.videoId,
        videoHeading: g.videoHeading,
        totalTrades: g.totalTrades,
        activeTrades: g.activeTrades,
        wins: g.wins,
        losses: g.losses,
        winRate: g.closedCount > 0 ? (g.wins / g.closedCount) * 100 : 0,
        totalPnl: g.closedPnl + g.activeUnrealizedPnl,
        avgPnl: g.closedCount > 0 ? g.closedPnl / g.closedCount : 0,
        avgReturnPct: g.returns.length > 0 ? g.returns.reduce((a, b) => a + b, 0) / g.returns.length : 0,
        consecutiveLosses,
        isMarkedX: shouldDeactivate,
        firstTradeAt: g.firstTradeAt,
        lastTradeAt: g.lastTradeAt,
        recentTrades: [...g.recentTrades]
          .sort((a, b) => (b.openedAt ?? '').localeCompare(a.openedAt ?? ''))
          .slice(0, 5),
      };
    })
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

export async function getStrategySignalStatusSummaries(): Promise<StrategySignalStatusSummary[]> {
  const { data, error } = await supabase
    .from('external_strategy_signals')
    .select('source_name, source_url, strategy_video_id, strategy_video_heading, execute_on_date, status, expires_at, created_at')
    .not('source_name', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1000);

  if (error || !data) return [];

  const nowMs = Date.now();

  const grouped = new Map<string, StrategySignalStatusSummary & { sortKey: string }>();
  const trackedTypeByKey = new Map<string, 'daily_signal' | 'daily_penny' | 'generic_strategy' | 'options_signal'>();
  const trackedTimeframesByKey = new Map<string, Array<'DAY_TRADE' | 'SWING_TRADE'>>();
  for (const row of data as Array<{
    source_name: string | null;
    source_url: string | null;
    strategy_video_id: string | null;
    strategy_video_heading: string | null;
    execute_on_date: string | null;
    status: string | null;
    expires_at: string | null;
    created_at: string | null;
  }>) {
    const source = (row.source_name ?? '').trim();
    if (!source) continue;
    const videoId = (row.strategy_video_id ?? '').trim() || null;
    const videoHeading = (row.strategy_video_heading ?? '').trim() || null;
    if (!videoId && !videoHeading) continue;

    // Treat PENDING signals whose expires_at has passed as EXPIRED (client-side until DB syncs)
    const effectiveStatus = (row.status === 'PENDING' && row.expires_at && new Date(row.expires_at).getTime() < nowMs)
      ? 'EXPIRED'
      : (row.status ?? null);

    const key = `${source}::${videoId ?? videoHeading}`;
    const sortKey = `${row.execute_on_date ?? ''}|${row.created_at ?? ''}`;
    const existing = grouped.get(key);
    if (!existing || sortKey > existing.sortKey) {
      grouped.set(key, {
        source,
        sourceUrl: row.source_url ?? null,
        videoId,
        videoHeading,
        platform: null,
        strategyType: null,
        applicableDate: row.execute_on_date ?? null,
        applicableTimeframes: null,
        latestSignalStatus: effectiveStatus,
        sortKey,
      });
    }
  }

  // Include tracked videos from strategy_videos table (single source of truth)
  try {
    const { data: tracked } = await supabase
      .from('strategy_videos')
      .select('video_id, platform, source_handle, source_name, canonical_url, reel_url, video_heading, strategy_type, trade_date, timeframe, applicable_timeframes, transcript, ingest_status, ingest_error')
      .eq('status', 'tracked');

    if (tracked && Array.isArray(tracked)) {
      for (const item of tracked as Array<{
        video_id: string | null;
        platform: string | null;
        source_handle: string | null;
        source_name: string | null;
        canonical_url: string | null;
        reel_url: string | null;
        video_heading: string | null;
        strategy_type: string | null;
        trade_date: string | null;
        timeframe: string | null;
        applicable_timeframes: string[] | null;
        transcript: string | null;
        ingest_status: string | null;
        ingest_error: string | null;
      }>) {
        const source = (item.source_name ?? '').trim();
        if (!source) continue;

        const videoId = (item.video_id ?? '').trim() || null;
        const videoHeading = (item.video_heading ?? '').trim() || 'Untitled video';
        if (!videoId && !videoHeading) continue;

        const sourceHandle = (item.source_handle ?? '').trim().replace(/^@+/, '');
        const inferredSourceUrl = sourceHandle
          ? `https://www.instagram.com/${sourceHandle}/`
          : (item.canonical_url ?? item.reel_url ?? null);

        const key = `${source}::${videoId ?? videoHeading}`;
        const strategyType = item.strategy_type === 'daily_signal' || item.strategy_type === 'daily_penny' || item.strategy_type === 'generic_strategy' || item.strategy_type === 'options_signal'
          ? item.strategy_type
          : null;
        if (strategyType) {
          trackedTypeByKey.set(key, strategyType);
        }
        const timeframes = (item.applicable_timeframes?.length
          ? item.applicable_timeframes
          : item.timeframe
            ? [item.timeframe]
            : []
        ).filter((t): t is 'DAY_TRADE' | 'SWING_TRADE' =>
          t === 'DAY_TRADE' || t === 'SWING_TRADE'
        ) as Array<'DAY_TRADE' | 'SWING_TRADE'>;
        if (timeframes.length > 0) {
          trackedTimeframesByKey.set(key, timeframes);
        }
        const transcript = (item.transcript ?? '').trim() || null;
        const ingestStatus = (item.ingest_status === 'pending' || item.ingest_status === 'transcribing' || item.ingest_status === 'done' || item.ingest_status === 'failed')
          ? item.ingest_status
          : null;
        const ingestError = (item.ingest_error ?? '').trim() || null;
        const platform = (item.platform === 'instagram' || item.platform === 'twitter' || item.platform === 'youtube')
          ? item.platform
          : null;

        if (!grouped.has(key)) {
          grouped.set(key, {
            source,
            sourceUrl: inferredSourceUrl,
            videoId,
            videoHeading,
            platform,
            strategyType,
            applicableDate: strategyType === 'daily_signal' || strategyType === 'daily_penny' ? (item.trade_date ?? null) : null,
            applicableTimeframes: timeframes.length > 0 ? timeframes : null,
            latestSignalStatus: null,
            sortKey: `${item.trade_date ?? ''}|`,
            transcript,
            ingestStatus,
            ingestError,
          });
        } else {
          const existing = grouped.get(key);
          if (existing) {
            const updates: Partial<StrategySignalStatusSummary> = {};
            if (strategyType && existing.strategyType == null) updates.strategyType = strategyType;
            if (platform && existing.platform == null) updates.platform = platform;
            if (timeframes.length > 0) updates.applicableTimeframes = timeframes;
            if (transcript != null) updates.transcript = transcript;
            if (ingestStatus != null) updates.ingestStatus = ingestStatus;
            if (ingestError != null) updates.ingestError = ingestError;
            if (Object.keys(updates).length > 0) {
              grouped.set(key, { ...existing, ...updates });
            }
          }
        }
      }
    }
  } catch {
    // non-blocking: UI still works from DB-only summaries
  }

  return [...grouped.entries()]
    .map(([key, value]) => {
      const strategyType = value.strategyType ?? trackedTypeByKey.get(key) ?? null;
      const applicableTimeframes = value.applicableTimeframes ?? trackedTimeframesByKey.get(key) ?? null;
      const { sortKey: _sortKey, ...rest } = value;
      return {
        ...rest,
        strategyType,
        applicableTimeframes: applicableTimeframes ?? null,
      };
    })
    .sort((a, b) => (b.applicableDate ?? '').localeCompare(a.applicableDate ?? ''));
}

export async function getPendingStrategySignals(limit = 200): Promise<PendingStrategySignal[]> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('external_strategy_signals')
    .select('id,ticker,signal,mode,source_name,source_url,strategy_video_id,strategy_video_heading,entry_price,execute_on_date,status,created_at')
    .eq('status', 'PENDING')
    .or(`expires_at.is.null,expires_at.gt.${now}`) // exclude signals whose window has already passed
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return [];

  // Deduplicate by (ticker, signal, entry_price, execute_on_date) — keep the most recent row.
  // Duplicates occur when the same video is imported more than once (re-categorization, double-click)
  // and the delete-before-insert runs under two different strategy_video_ids.
  const seen = new Set<string>();
  const deduped: PendingStrategySignal[] = [];
  for (const row of (data ?? []) as PendingStrategySignal[]) {
    const key = `${row.ticker}|${row.signal}|${row.entry_price}|${row.execute_on_date}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(row);
    }
  }
  return deduped;
}

/** Today's external strategy signals (PENDING, EXPIRED, or SKIPPED) for manual execution. */
export async function getTodaySignalsForManualExecute(): Promise<PendingStrategySignal[]> {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
  const { data, error } = await supabase
    .from('external_strategy_signals')
    .select('id,ticker,signal,mode,source_name,source_url,strategy_video_id,strategy_video_heading,entry_price,execute_on_date,status,failure_reason,created_at')
    .eq('execute_on_date', todayET)
    .in('status', ['PENDING', 'EXPIRED', 'SKIPPED'])
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return [];

  // Deduplicate same as getPendingStrategySignals
  const seen = new Set<string>();
  const deduped: PendingStrategySignal[] = [];
  for (const row of (data ?? []) as PendingStrategySignal[]) {
    const key = `${row.ticker}|${row.signal}|${row.entry_price}|${row.execute_on_date}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(row);
    }
  }
  return deduped;
}

/** Force-execute an external strategy signal via auto-trader (bypasses execution window). */
export async function executeSignal(signalId: string): Promise<{ ok: boolean; result?: string; error?: string }> {
  try {
    const res = await fetch('http://localhost:3001/api/scheduler/execute-signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signal_id: signalId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return {
      ok: false,
      error: msg.includes('fetch') || msg.includes('Failed') || msg.includes('network')
        ? 'Auto-trader unreachable. Is it running on localhost:3001?'
        : msg,
    };
  }
}

/**
 * Mark all PENDING signals that can no longer be traded as EXPIRED:
 *   1. Signals whose expires_at window has passed
 *   2. Daily signals whose execute_on_date is before today (market closed, too late to trade)
 * Safe to call any time — harmless outside market hours.
 * Returns the number of rows updated.
 */
export async function expireStaleSignals(): Promise<number> {
  const now = new Date().toISOString();
  // today in ET — signals for yesterday's date should expire
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD

  // Sweep 1: signals with an explicit expires_at that has passed
  const { data: byTime, error: e1 } = await supabase
    .from('external_strategy_signals')
    .update({ status: 'EXPIRED', updated_at: now })
    .eq('status', 'PENDING')
    .not('expires_at', 'is', null)
    .lt('expires_at', now)
    .select('id');

  // Sweep 2: daily signals whose trade date is before today (no expires_at set)
  const { data: byDate, error: e2 } = await supabase
    .from('external_strategy_signals')
    .update({ status: 'EXPIRED', updated_at: now })
    .eq('status', 'PENDING')
    .not('execute_on_date', 'is', null)
    .lt('execute_on_date', todayET)
    .select('id');

  // Sweep 3: signals for today if today is a weekend (market closed all day)
  const todayDayOfWeek = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  const isWeekend = todayDayOfWeek === 'Sat' || todayDayOfWeek === 'Sun';
  let byWeekend: { id: string }[] = [];
  if (isWeekend) {
    const { data: wd } = await supabase
      .from('external_strategy_signals')
      .update({ status: 'EXPIRED', updated_at: now })
      .eq('status', 'PENDING')
      .eq('execute_on_date', todayET)
      .select('id');
    byWeekend = wd ?? [];
  }

  if (e1) console.warn('[expireStaleSignals] expires_at sweep failed:', e1.message);
  if (e2) console.warn('[expireStaleSignals] execute_on_date sweep failed:', e2.message);

  return ((byTime ?? []).length + (byDate ?? []).length + byWeekend.length);
}

// ── MFE/MAE Performance Data ─────────────────────────────

export interface MfeMaeDataPoint {
  ticker: string;
  maxRunup: number;
  maxDrawdown: number;
  realizedReturn: number;
  strategy: string;
}

export async function getMfeMaeData(accountView: AccountView = 'paper'): Promise<MfeMaeDataPoint[]> {
  const { data } = await supabase
    .from('trade_performance_log')
    .select('ticker, max_runup_pct_during_hold, max_drawdown_pct_during_hold, realized_return_pct, strategy')
    .not('max_runup_pct_during_hold', 'is', null)
    .not('max_drawdown_pct_during_hold', 'is', null)
    .eq('account_type', accountView === 'live' ? 'live' : 'paper')
    .order('created_at', { ascending: false })
    .limit(500);
  return (data ?? []).map(t => ({
    ticker: t.ticker,
    maxRunup: t.max_runup_pct_during_hold,
    maxDrawdown: t.max_drawdown_pct_during_hold,
    realizedReturn: t.realized_return_pct,
    strategy: t.strategy,
  }));
}

// ── Portfolio Snapshots ──────────────────────────────────

export interface PortfolioSnapshot {
  id: string;
  snapshot_date: string;
  account_id: string | null;
  total_value: number | null;
  cash_balance: number | null;
  total_pnl: number | null;
  positions: unknown[] | null;
  open_trade_count: number;
  created_at: string;
}

/** Save a daily portfolio snapshot (upserts by date + account) */
export async function savePortfolioSnapshot(snapshot: {
  accountId?: string;
  totalValue: number;
  cashBalance?: number;
  totalPnl: number;
  positions: { ticker: string; qty: number; avgCost: number; mktPrice: number; mktValue: number; unrealizedPnl: number }[];
  openTradeCount: number;
}): Promise<void> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const { error } = await supabase
    .from('portfolio_snapshots')
    .upsert({
      snapshot_date: today,
      account_id: snapshot.accountId ?? 'default',
      total_value: snapshot.totalValue,
      cash_balance: snapshot.cashBalance ?? null,
      total_pnl: snapshot.totalPnl,
      positions: snapshot.positions,
      open_trade_count: snapshot.openTradeCount,
    }, { onConflict: 'snapshot_date,account_id' });

  if (error) console.error('[savePortfolioSnapshot] Failed:', error.message);
}

/** Get portfolio snapshots for charting */
export async function getPortfolioSnapshots(days = 30): Promise<PortfolioSnapshot[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('portfolio_snapshots')
    .select('*')
    .gte('snapshot_date', since)
    .order('snapshot_date', { ascending: true });

  if (error) return [];
  return (data ?? []) as PortfolioSnapshot[];
}

// ── Influencer Trade Pattern Analysis ────────────────────

export type TimeBucket = '9:30-10:00' | '10:00-10:30' | '10:30-11:00' | '11:00-12:00' | '12:00+';

export interface TimeBucketStats {
  bucket: TimeBucket;
  total: number;
  wins: number;
  losses: number;
  pending: number;
  winRate: number | null; // null until enough closed trades
  avgPnlPct: number | null;
}

export interface SpyAlignmentStats {
  aligned: { total: number; wins: number; losses: number; winRate: number | null };
  against: { total: number; wins: number; losses: number; winRate: number | null };
}

export interface InfluencerTradePatterns {
  timeBuckets: TimeBucketStats[];
  spyAlignment: SpyAlignmentStats;
  totalTrades: number;
  closedTrades: number;
}

/** Classify a filled_at UTC timestamp into an ET time bucket */
function classifyTimeBucket(filledAt: string): TimeBucket {
  const etTime = new Date(filledAt).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [h, m] = etTime.split(':').map(Number);
  const mins = (h ?? 0) * 60 + (m ?? 0);
  if (mins < 10 * 60) return '9:30-10:00';
  if (mins < 10 * 60 + 30) return '10:00-10:30';
  if (mins < 11 * 60) return '10:30-11:00';
  if (mins < 12 * 60) return '11:00-12:00';
  return '12:00+';
}

/**
 * Fetch influencer day trade execution patterns.
 * Computes win/loss rates by entry time bucket and SPY alignment from
 * paper_trades (filled_at for time) + auto_trade_events (spy_change_pct).
 */
export async function fetchInfluencerTradePatterns(): Promise<InfluencerTradePatterns> {
  const BUCKETS: TimeBucket[] = ['9:30-10:00', '10:00-10:30', '10:30-11:00', '11:00-12:00', '12:00+'];

  // Fetch all influencer day trades that have been filled
  const { data: trades } = await supabase
    .from('paper_trades')
    .select('id, ticker, signal, strategy_video_id, pnl_percent, pnl, status, filled_at')
    .not('strategy_video_id', 'is', null)
    .eq('mode', 'DAY_TRADE')
    .not('filled_at', 'is', null)
    .order('filled_at', { ascending: false });

  if (!trades || trades.length === 0) {
    return {
      timeBuckets: BUCKETS.map(b => ({ bucket: b, total: 0, wins: 0, losses: 0, pending: 0, winRate: null, avgPnlPct: null })),
      spyAlignment: {
        aligned: { total: 0, wins: 0, losses: 0, winRate: null },
        against: { total: 0, wins: 0, losses: 0, winRate: null },
      },
      totalTrades: 0,
      closedTrades: 0,
    };
  }

  // Fetch execution events for spy_change_pct (only trades with metadata)
  const { data: events } = await supabase
    .from('auto_trade_events')
    .select('ticker, strategy_video_id, metadata, created_at')
    .eq('source', 'external_signal')
    .eq('action', 'executed')
    .eq('mode', 'DAY_TRADE')
    .not('metadata', 'is', null);

  // Build a spy_change_pct lookup: ticker+videoId → spy change
  const spyMap = new Map<string, number>();
  for (const ev of events ?? []) {
    const meta = ev.metadata as Record<string, unknown> | null;
    const pct = meta?.spy_change_pct;
    if (typeof pct === 'number' && ev.strategy_video_id) {
      spyMap.set(`${ev.ticker}::${ev.strategy_video_id}`, pct);
    }
  }

  // Bucket stats accumulator
  const bucketMap = new Map<TimeBucket, { wins: number; losses: number; pending: number; pnls: number[] }>(
    BUCKETS.map(b => [b, { wins: 0, losses: 0, pending: 0, pnls: [] }])
  );
  const spyAligned = { wins: 0, losses: 0, total: 0 };
  const spyAgainst = { wins: 0, losses: 0, total: 0 };

  // All terminal statuses + 'EXPIRED' (not a formal TradeStatus but can appear in data)
  const ALL_TERMINAL_WITH_EXPIRED = [...ALL_TERMINAL_STATUSES, 'EXPIRED'] as string[];

  for (const trade of trades) {
    const isClosed = ALL_TERMINAL_WITH_EXPIRED.includes(trade.status);
    const isWin = isClosed && (trade.pnl ?? 0) > 0;
    const isLoss = isClosed && (trade.pnl ?? 0) <= 0;

    const bucket = classifyTimeBucket(trade.filled_at as string);
    const b = bucketMap.get(bucket)!;
    if (isWin) { b.wins++; if (trade.pnl_percent != null) b.pnls.push(trade.pnl_percent); }
    else if (isLoss) { b.losses++; if (trade.pnl_percent != null) b.pnls.push(trade.pnl_percent); }
    else b.pending++;

    // SPY alignment: classify based on spy_change_pct at entry time
    const spyPct = spyMap.get(`${trade.ticker}::${trade.strategy_video_id}`);
    if (spyPct != null && isClosed) {
      const aligned =
        (trade.signal === 'BUY' && spyPct >= 0) ||
        (trade.signal === 'SELL' && spyPct <= 0);
      if (aligned) {
        spyAligned.total++;
        if (isWin) spyAligned.wins++;
        else if (isLoss) spyAligned.losses++;
      } else {
        spyAgainst.total++;
        if (isWin) spyAgainst.wins++;
        else if (isLoss) spyAgainst.losses++;
      }
    }
  }

  const timeBuckets: TimeBucketStats[] = BUCKETS.map(b => {
    const stats = bucketMap.get(b)!;
    const closed = stats.wins + stats.losses;
    return {
      bucket: b,
      total: closed + stats.pending,
      wins: stats.wins,
      losses: stats.losses,
      pending: stats.pending,
      winRate: closed >= 2 ? Math.round((stats.wins / closed) * 100) : null,
      avgPnlPct: stats.pnls.length >= 2
        ? parseFloat((stats.pnls.reduce((a, b) => a + b, 0) / stats.pnls.length).toFixed(2))
        : null,
    };
  });

  const closedTrades = trades.filter(t => ALL_TERMINAL_WITH_EXPIRED.includes(t.status)).length;

  return {
    timeBuckets,
    spyAlignment: {
      aligned: {
        total: spyAligned.total,
        wins: spyAligned.wins,
        losses: spyAligned.losses,
        winRate: spyAligned.total >= 2 ? Math.round((spyAligned.wins / spyAligned.total) * 100) : null,
      },
      against: {
        total: spyAgainst.total,
        wins: spyAgainst.wins,
        losses: spyAgainst.losses,
        winRate: spyAgainst.total >= 2 ? Math.round((spyAgainst.wins / spyAgainst.total) * 100) : null,
      },
    },
      totalTrades: trades.length,
    closedTrades,
  };
}

// ── System Learning / Auto-Tune ───────────────────────────

export interface TuneDecision {
  param: string;
  oldValue: number | boolean | null;
  newValue: number | boolean;
  reason: string;
  category: string;
}

export interface TuneLogEntry {
  id: string;
  created_at: string;
  trigger: 'scheduled' | 'manual';
  applied: boolean;
  notes: string;
  decisions: TuneDecision[];
  analysis: {
    window_days: number;
    total_trades_analyzed: number;
    categories: Array<{
      category: string;
      trades: number;
      wins: number;
      winRate: number;
      avgReturnPct: number;
      totalPnl: number;
      profitFactor: number;
    }>;
  };
}

export async function getStrategyTuneLogs(limit = 10): Promise<TuneLogEntry[]> {
  const { data } = await supabase
    .from('strategy_tune_log')
    .select('id, created_at, trigger, applied, notes, decisions, analysis')
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data ?? []) as TuneLogEntry[];
}

// ── Order trade context ────────────────────────────────────────────────────
// Lightweight record used to enrich IB Open Orders with mode + source info.
export interface OrderTradeContext {
  ticker: string;
  mode: string;
  scanner_reason: string | null;
  entry_trigger_type: string | null;
  notes: string | null;
  opened_at: string | null;
}

export interface OrderTradeContextMaps {
  byOrderId: Map<number, OrderTradeContext>;
  /** Fallback — keyed by uppercase ticker; first active trade wins per ticker. */
  byTicker: Map<string, OrderTradeContext>;
}

/**
 * Returns maps of IB order ID and ticker → trade context for all active/submitted trades.
 * Used by the Open Orders panel to show mode and source without a full trade fetch.
 * Bracket child orders (parentId != 0) don't have their own paper_trades row, so
 * the byTicker fallback is used for them.
 */
export async function getOrderTradeContext(): Promise<OrderTradeContextMaps> {
  const { data } = await supabase
    .from('paper_trades')
    .select('ticker, ib_order_id, mode, scanner_reason, entry_trigger_type, notes, opened_at')
    .in('status', ['ACTIVE', 'SUBMITTED', 'FILLED'])
    .not('ib_order_id', 'is', null);

  const byOrderId = new Map<number, OrderTradeContext>();
  const byTicker = new Map<string, OrderTradeContext>();
  for (const row of data ?? []) {
    const ctx: OrderTradeContext = {
      ticker: row.ticker ?? '',
      mode: row.mode ?? '',
      scanner_reason: row.scanner_reason ?? null,
      entry_trigger_type: row.entry_trigger_type ?? null,
      notes: row.notes ?? null,
      opened_at: row.opened_at ?? null,
    };
    const id = Number(row.ib_order_id);
    if (!isNaN(id)) byOrderId.set(id, ctx);
    const t = (row.ticker ?? '').toUpperCase();
    if (t && !byTicker.has(t)) byTicker.set(t, ctx);
  }
  return { byOrderId, byTicker };
}

export async function triggerAutoTune(): Promise<{ ok: boolean; decisionsCount: number; decisions: TuneDecision[]; error?: string }> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const res = await fetch(`${supabaseUrl}/functions/v1/auto-tune-strategy-config`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${supabaseKey}`,
    },
    body: JSON.stringify({ trigger: 'manual' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, decisionsCount: 0, decisions: [], error: data?.error ?? `HTTP ${res.status}` };
  return data as { ok: boolean; decisionsCount: number; decisions: TuneDecision[] };
}

// ── Pre-session ORB setups ──────────────────────────────────────────────────

export interface PresessionSetup {
  id: string;
  ticker: string;
  trade_date: string;
  signal: 'BUY' | 'SELL';
  trigger_price: number;
  stop_loss: number;
  take_profit1: number;
  take_profit2: number | null;
  prior_day_high: number;
  prior_day_low: number;
  prior_day_close: number;
  avg_volume_10d: number | null;
  rvol: number | null;
  trend_4h: string | null;
  atr: number;
  reason: string;
  status: 'PENDING' | 'TRIGGERED' | 'EXPIRED' | 'SKIPPED';
  triggered_at: string | null;
  created_at: string;
}

/** Fetch tonight's (next trading day's) ORB pre-session setups */
export async function getTonightsPresessionSetups(): Promise<PresessionSetup[]> {
  // Compute next trading date from ET perspective
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const d = new Date(nowET);
  // If before 4 PM, "tonight" = today's setups; after 4 PM = tomorrow
  if (nowET.getHours() >= 16) d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  const targetDate = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const { data, error } = await supabase
    .from('pre_session_setups')
    .select('*')
    .eq('trade_date', targetDate)
    .order('ticker');

  if (error) throw new Error(error.message);
  return (data ?? []) as PresessionSetup[];
}

/** Fetch today's ORB setups (for morning tracking) */
export async function getTodaysPresessionSetups(): Promise<PresessionSetup[]> {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const { data, error } = await supabase
    .from('pre_session_setups')
    .select('*')
    .eq('trade_date', todayET)
    .order('status', { ascending: true })  // PENDING first
    .order('ticker');

  if (error) throw new Error(error.message);
  return (data ?? []) as PresessionSetup[];
}
