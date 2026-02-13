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
  source: 'scanner' | 'suggested_finds' | 'manual' | 'system' | 'dip_buy' | 'profit_take' | null;
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

// ── Category Performance (Signal Quality) ────────────────

export interface CategoryPerformance {
  category: 'suggested_finds' | 'day_trade' | 'swing_trade' | 'dip_buy' | 'profit_take';
  totalTrades: number;
  activeTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  avgReturnPct: number;
  bestTrade: { ticker: string; pnl: number } | null;
  worstTrade: { ticker: string; pnl: number } | null;
  totalDeployed: number;
}

/**
 * Recalculate performance broken down by category:
 * - suggested_finds: LONG_TERM mode trades (initial picks only, not dip_buy/profit_take)
 * - day_trade: DAY_TRADE mode scanner trades
 * - swing_trade: SWING_TRADE mode scanner trades
 * - dip_buy: dip buy add-ons (portfolio management)
 * - profit_take: profit take trims (portfolio management)
 */
export async function recalculatePerformanceByCategory(): Promise<CategoryPerformance[]> {
  const { data: allTrades, error } = await supabase
    .from('paper_trades')
    .select('*');

  if (error || !allTrades) return [];
  const trades = allTrades as PaperTrade[];

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
      key: 'day_trade',
      filter: (t) => t.mode === 'DAY_TRADE',
    },
    {
      key: 'swing_trade',
      filter: (t) => t.mode === 'SWING_TRADE',
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
    const activeStatuses = ['PENDING', 'SUBMITTED', 'FILLED', 'PARTIAL'];
    const closedStatuses = ['STOPPED', 'TARGET_HIT', 'CLOSED'];

    const active = catTrades.filter(t => activeStatuses.includes(t.status));
    // Only count completed trades that actually filled
    const completed = catTrades.filter(
      t => closedStatuses.includes(t.status) && t.fill_price != null
    );
    const wins = completed.filter(t => (t.pnl ?? 0) > 0);
    const losses = completed.filter(t => (t.pnl ?? 0) < 0);

    const totalPnl = completed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const avgPnl = completed.length > 0 ? totalPnl / completed.length : 0;

    // Avg return %
    const returns = completed
      .filter(t => t.fill_price && t.quantity)
      .map(t => ((t.pnl ?? 0) / ((t.fill_price ?? 1) * (t.quantity ?? 1))) * 100);
    const avgReturnPct = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;

    // For active long-term positions with unrealized P&L, include in active stats
    const unrealizedPnl = active
      .filter(t => t.status === 'FILLED' && t.pnl != null)
      .reduce((s, t) => s + (t.pnl ?? 0), 0);

    // Best/worst
    const sortedByPnl = [...completed].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
    const best = sortedByPnl[0] ?? null;
    const worst = sortedByPnl[sortedByPnl.length - 1] ?? null;

    const totalDeployed = active.reduce((s, t) => s + (t.position_size ?? 0), 0);

    results.push({
      category: cat.key,
      totalTrades: catTrades.length,
      activeTrades: active.length,
      wins: wins.length,
      losses: losses.length,
      winRate: completed.length > 0 ? (wins.length / completed.length) * 100 : 0,
      totalPnl: totalPnl + unrealizedPnl,
      avgPnl,
      avgReturnPct,
      bestTrade: best ? { ticker: best.ticker, pnl: best.pnl ?? 0 } : null,
      worstTrade: worst && completed.length > 0 ? { ticker: worst.ticker, pnl: worst.pnl ?? 0 } : null,
      totalDeployed,
    });
  }

  return results;
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
