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
  source: 'scanner' | 'suggested_finds' | 'manual' | 'system' | 'dip_buy' | 'profit_take' | 'loss_cut' | 'external_signal' | null;
  mode: 'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM' | null;
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

/** Get today's executed events (all modes — day, swing, long-term, system closes) */
export async function getTodaysExecutedEvents(): Promise<AutoTradeEventRecord[]> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // Fetch executed trades + system close events (both profit and loss)
  const { data, error } = await supabase
    .from('auto_trade_events')
    .select('*')
    .in('action', ['executed', 'failed'])
    .gte('created_at', todayStart.toISOString())
    .order('created_at', { ascending: false });

  if (error) return [];
  // Filter out non-system 'failed' events (only keep system closes + all executed)
  return ((data ?? []) as AutoTradeEventRecord[]).filter(
    e => e.action === 'executed' || e.source === 'system'
  );
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
}

export interface StrategySignalStatusSummary {
  source: string;
  sourceUrl: string | null;
  videoId: string | null;
  videoHeading: string | null;
  applicableDate: string | null;
  latestSignalStatus: string | null;
}

interface TrackedStrategyVideoRecord {
  videoId?: string;
  sourceHandle?: string;
  sourceName?: string;
  reelUrl?: string;
  canonicalUrl?: string;
  videoHeading?: string;
  strategyType?: 'daily_signal' | 'generic_strategy' | string;
  tradeDate?: string;
  status?: string;
}

export interface PendingStrategySignal {
  id: string;
  ticker: string;
  signal: 'BUY' | 'SELL';
  mode: 'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM';
  source_name: string;
  source_url: string | null;
  strategy_video_id: string | null;
  strategy_video_heading: string | null;
  entry_price: number | null;
  execute_on_date: string;
  status: string;
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
    // Exclude cancelled/rejected — these never executed, no money at risk
    const excludedStatuses = ['CANCELLED', 'REJECTED'];
    const meaningful = catTrades.filter(t => !excludedStatuses.includes(t.status));

    const activeStatuses = ['PENDING', 'SUBMITTED', 'FILLED', 'PARTIAL'];
    const closedStatuses = ['STOPPED', 'TARGET_HIT', 'CLOSED'];

    const active = meaningful.filter(t => activeStatuses.includes(t.status));
    // Only count completed trades that actually filled
    const completed = meaningful.filter(
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
      totalTrades: meaningful.length,
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

export async function recalculatePerformanceByStrategySource(): Promise<StrategySourcePerformance[]> {
  const { data: allTrades, error } = await supabase
    .from('paper_trades')
    .select('*')
    .not('strategy_source', 'is', null);

  if (error || !allTrades) return [];
  const trades = allTrades as PaperTrade[];

  const activeStatuses = new Set(['PENDING', 'SUBMITTED', 'FILLED', 'PARTIAL']);
  const closedStatuses = new Set(['STOPPED', 'TARGET_HIT', 'CLOSED']);

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
    if (activeStatuses.has(trade.status)) {
      curr.activeTrades += 1;
      if (trade.status === 'FILLED' && trade.pnl != null) {
        curr.activeUnrealizedPnl += trade.pnl;
      }
    }

    if (closedStatuses.has(trade.status) && trade.fill_price != null) {
      curr.closedCount += 1;
      const pnl = trade.pnl ?? 0;
      curr.closedPnl += pnl;
      if (pnl > 0) curr.wins += 1;
      if (pnl < 0) curr.losses += 1;
      curr.closedOutcomes.push({
        pnl,
        at: trade.closed_at ?? trade.opened_at ?? '',
      });
    }

    groups.set(source, curr);
  }

  return [...groups.entries()]
    .map(([source, s]) => {
      const sortedClosed = [...s.closedOutcomes].sort((a, b) => b.at.localeCompare(a.at));
      let consecutiveLosses = 0;
      for (const outcome of sortedClosed) {
        if (outcome.pnl < 0) consecutiveLosses += 1;
        else break;
      }
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
        isMarkedX: consecutiveLosses >= 2,
      };
    })
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

export async function recalculatePerformanceByStrategyVideo(): Promise<StrategyVideoPerformance[]> {
  const { data: allTrades, error } = await supabase
    .from('paper_trades')
    .select('*')
    .not('strategy_source', 'is', null);

  if (error || !allTrades) return [];
  const trades = allTrades as PaperTrade[];

  const activeStatuses = new Set(['PENDING', 'SUBMITTED', 'FILLED', 'PARTIAL']);
  const closedStatuses = new Set(['STOPPED', 'TARGET_HIT', 'CLOSED']);

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
    };

    if (!curr.sourceUrl && trade.strategy_source_url) curr.sourceUrl = trade.strategy_source_url;
    if (!curr.videoId && videoId) curr.videoId = videoId;

    const openedAt = trade.opened_at ?? null;
    if (openedAt) {
      if (!curr.firstTradeAt || openedAt < curr.firstTradeAt) curr.firstTradeAt = openedAt;
      if (!curr.lastTradeAt || openedAt > curr.lastTradeAt) curr.lastTradeAt = openedAt;
    }

    curr.totalTrades += 1;
    if (activeStatuses.has(trade.status)) {
      curr.activeTrades += 1;
      if (trade.status === 'FILLED' && trade.pnl != null) {
        curr.activeUnrealizedPnl += trade.pnl;
      }
    }

    if (closedStatuses.has(trade.status) && trade.fill_price != null) {
      curr.closedCount += 1;
      const pnl = trade.pnl ?? 0;
      curr.closedPnl += pnl;
      if (pnl > 0) curr.wins += 1;
      if (pnl < 0) curr.losses += 1;
      curr.closedOutcomes.push({
        pnl,
        at: trade.closed_at ?? trade.opened_at ?? '',
      });
      if (trade.fill_price && trade.quantity) {
        curr.returns.push((pnl / (trade.fill_price * trade.quantity)) * 100);
      }
    }

    groups.set(key, curr);
  }

  return [...groups.values()]
    .map(g => {
      const sortedClosed = [...g.closedOutcomes].sort((a, b) => b.at.localeCompare(a.at));
      let consecutiveLosses = 0;
      for (const outcome of sortedClosed) {
        if (outcome.pnl < 0) consecutiveLosses += 1;
        else break;
      }
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
        isMarkedX: consecutiveLosses >= 2,
        firstTradeAt: g.firstTradeAt,
        lastTradeAt: g.lastTradeAt,
      };
    })
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

export async function getStrategySignalStatusSummaries(): Promise<StrategySignalStatusSummary[]> {
  const { data, error } = await supabase
    .from('external_strategy_signals')
    .select('source_name, source_url, strategy_video_id, strategy_video_heading, execute_on_date, status, created_at')
    .not('source_name', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1000);

  if (error || !data) return [];

  const grouped = new Map<string, StrategySignalStatusSummary & { sortKey: string }>();
  for (const row of data as Array<{
    source_name: string | null;
    source_url: string | null;
    strategy_video_id: string | null;
    strategy_video_heading: string | null;
    execute_on_date: string | null;
    status: string | null;
    created_at: string | null;
  }>) {
    const source = (row.source_name ?? '').trim();
    if (!source) continue;
    const videoId = (row.strategy_video_id ?? '').trim() || null;
    const videoHeading = (row.strategy_video_heading ?? '').trim() || null;
    if (!videoId && !videoHeading) continue;

    const key = `${source}::${videoId ?? videoHeading}`;
    const sortKey = `${row.execute_on_date ?? ''}|${row.created_at ?? ''}`;
    const existing = grouped.get(key);
    if (!existing || sortKey > existing.sortKey) {
      grouped.set(key, {
        source,
        sourceUrl: row.source_url ?? null,
        videoId,
        videoHeading,
        applicableDate: row.execute_on_date ?? null,
        latestSignalStatus: row.status ?? null,
        sortKey,
      });
    }
  }

  // Include tracked videos even before they generate signals/trades
  try {
    const trackedRes = await fetch('/strategy-videos.json', { cache: 'no-store' });
    if (trackedRes.ok) {
      const tracked = await trackedRes.json() as unknown;
      if (Array.isArray(tracked)) {
        for (const item of tracked as TrackedStrategyVideoRecord[]) {
          if (!item || typeof item !== 'object') continue;
          if (item.status && item.status !== 'tracked') continue;

          const source = (item.sourceName ?? '').trim();
          if (!source) continue;

          const videoId = (item.videoId ?? '').trim() || null;
          const videoHeading = (item.videoHeading ?? '').trim() || videoId;
          if (!videoId && !videoHeading) continue;

          const sourceHandle = (item.sourceHandle ?? '').trim().replace(/^@+/, '');
          const inferredSourceUrl = sourceHandle
            ? `https://www.instagram.com/${sourceHandle}/`
            : (item.canonicalUrl ?? item.reelUrl ?? null);

          const key = `${source}::${videoId ?? videoHeading}`;
          if (!grouped.has(key)) {
            grouped.set(key, {
              source,
              sourceUrl: inferredSourceUrl,
              videoId,
              videoHeading,
              applicableDate: item.strategyType === 'daily_signal' ? (item.tradeDate ?? null) : null,
              latestSignalStatus: null,
              sortKey: `${item.tradeDate ?? ''}|`,
            });
          }
        }
      }
    }
  } catch {
    // non-blocking: UI still works from DB-only summaries
  }

  return [...grouped.values()]
    .map(({ sortKey: _sortKey, ...summary }) => summary)
    .sort((a, b) => (b.applicableDate ?? '').localeCompare(a.applicableDate ?? ''));
}

export async function getPendingStrategySignals(limit = 200): Promise<PendingStrategySignal[]> {
  const { data, error } = await supabase
    .from('external_strategy_signals')
    .select('id,ticker,signal,mode,source_name,source_url,strategy_video_id,strategy_video_heading,entry_price,execute_on_date,status,created_at')
    .eq('status', 'PENDING')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return [];
  return (data ?? []) as PendingStrategySignal[];
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
