/**
 * Paper Trades API — Supabase CRUD for the paper_trades, trade_learnings,
 * and trade_performance tables.
 */

import { supabase } from './supabaseClient';

// ── Types ────────────────────────────────────────────────

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
  | 'cancelled';

export interface PaperTrade {
  id: string;
  ticker: string;
  mode: 'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM';
  signal: 'BUY' | 'SELL';
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
  status: TradeStatus;
  fill_price: number | null;
  close_price: number | null;
  pnl: number | null;
  pnl_percent: number | null;
  opened_at: string;
  filled_at: string | null;
  closed_at: string | null;
  close_reason: CloseReason | null;
  scanner_reason: string | null;
  fa_rationale: { technical?: string; sentiment?: string; risk?: string } | null;
  notes: string | null;
  created_at: string;
}

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
    .in('status', ['PENDING', 'SUBMITTED', 'FILLED', 'PARTIAL'])
    .order('opened_at', { ascending: false });

  if (error) throw new Error(`Failed to fetch active trades: ${error.message}`);
  return (data ?? []) as PaperTrade[];
}

/** Get all trades (most recent first) */
export async function getAllTrades(limit = 50): Promise<PaperTrade[]> {
  const { data, error } = await supabase
    .from('paper_trades')
    .select('*')
    .order('opened_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to fetch trades: ${error.message}`);
  return (data ?? []) as PaperTrade[];
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
    .in('status', ['PENDING', 'SUBMITTED', 'FILLED', 'PARTIAL']);

  if (error) return false;
  return (count ?? 0) > 0;
}

/** Count active positions */
export async function countActivePositions(): Promise<number> {
  const { count, error } = await supabase
    .from('paper_trades')
    .select('id', { count: 'exact', head: true })
    .in('status', ['PENDING', 'SUBMITTED', 'FILLED', 'PARTIAL']);

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

export interface AutoTradeEventRecord {
  id: string;
  ticker: string;
  event_type: 'info' | 'success' | 'warning' | 'error';
  action: 'executed' | 'skipped' | 'failed' | null;
  source: 'scanner' | 'suggested_finds' | 'manual' | 'system' | null;
  mode: 'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM' | null;
  message: string;
  scanner_signal: string | null;
  scanner_confidence: number | null;
  fa_recommendation: string | null;
  fa_confidence: number | null;
  skip_reason: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

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
export async function getAutoTradeEvents(limit = 100): Promise<AutoTradeEventRecord[]> {
  const { data, error } = await supabase
    .from('auto_trade_events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return [];
  return (data ?? []) as AutoTradeEventRecord[];
}

/** Get auto-trade events for a specific ticker */
export async function getAutoTradeEventsByTicker(
  ticker: string,
  limit = 50
): Promise<AutoTradeEventRecord[]> {
  const { data, error } = await supabase
    .from('auto_trade_events')
    .select('*')
    .eq('ticker', ticker)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return [];
  return (data ?? []) as AutoTradeEventRecord[];
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
export async function recalculatePerformance(): Promise<TradePerformance | null> {
  const { data: trades, error } = await supabase
    .from('paper_trades')
    .select('*')
    .in('status', ['STOPPED', 'TARGET_HIT', 'CLOSED']);

  if (error || !trades || trades.length === 0) return null;

  // Only count trades that actually filled — exclude expired/unfilled orders
  const completed = (trades as PaperTrade[]).filter(t => t.fill_price != null);
  const wins = completed.filter(t => (t.pnl ?? 0) > 0);
  const losses = completed.filter(t => (t.pnl ?? 0) < 0);
  const breakevens = completed.filter(t => (t.pnl ?? 0) === 0);

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
