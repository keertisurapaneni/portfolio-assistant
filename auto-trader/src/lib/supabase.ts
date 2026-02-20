/**
 * Supabase client for the auto-trader server.
 *
 * Uses SUPABASE_SERVICE_ROLE_KEY to bypass RLS — this is a trusted
 * server-side process, not a browser client.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!_client) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    }
    _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return _client;
}

export function getSupabaseUrl(): string { return SUPABASE_URL; }
export function getSupabaseAnonKey(): string { return SUPABASE_ANON_KEY; }
export function isConfigured(): boolean {
  return !!(SUPABASE_URL && SUPABASE_SERVICE_KEY && SUPABASE_ANON_KEY);
}

// ── Auto-Trader Config ──────────────────────────────────

export interface AutoTraderConfig {
  enabled: boolean;
  maxPositions: number;
  positionSize: number;
  minScannerConfidence: number;
  minFAConfidence: number;
  minSuggestedFindsConviction: number;
  accountId: string | null;
  dayTradeAutoClose: boolean;
  maxTotalAllocation: number;
  maxDailyDeployment: number;
  useDynamicSizing: boolean;
  portfolioValue: number;
  baseAllocationPct: number;
  maxPositionPct: number;
  riskPerTradePct: number;
  dipBuyEnabled: boolean;
  dipBuyTier1Pct: number; dipBuyTier1SizePct: number;
  dipBuyTier2Pct: number; dipBuyTier2SizePct: number;
  dipBuyTier3Pct: number; dipBuyTier3SizePct: number;
  dipBuyCooldownHours: number;
  profitTakeEnabled: boolean;
  profitTakeTier1Pct: number; profitTakeTier1TrimPct: number;
  profitTakeTier2Pct: number; profitTakeTier2TrimPct: number;
  profitTakeTier3Pct: number; profitTakeTier3TrimPct: number;
  minHoldPct: number;
  lossCutEnabled: boolean;
  lossCutTier1Pct: number; lossCutTier1SellPct: number;
  lossCutTier2Pct: number; lossCutTier2SellPct: number;
  lossCutTier3Pct: number; lossCutTier3SellPct: number;
  lossCutMinHoldDays: number;
  marketRegimeEnabled: boolean;
  maxSectorPct: number;
  earningsAvoidEnabled: boolean;
  earningsBlackoutDays: number;
  kellyAdaptiveEnabled: boolean;
}

const DEFAULT_CONFIG: AutoTraderConfig = {
  enabled: false, maxPositions: 3, positionSize: 1000,
  minScannerConfidence: 7, minFAConfidence: 7, minSuggestedFindsConviction: 8,
  accountId: null, dayTradeAutoClose: true,
  maxTotalAllocation: 500_000, maxDailyDeployment: 50_000,
  useDynamicSizing: true, portfolioValue: 1_000_000,
  baseAllocationPct: 2.0, maxPositionPct: 5.0, riskPerTradePct: 1.0,
  dipBuyEnabled: true,
  dipBuyTier1Pct: 10, dipBuyTier1SizePct: 25,
  dipBuyTier2Pct: 20, dipBuyTier2SizePct: 50,
  dipBuyTier3Pct: 30, dipBuyTier3SizePct: 75,
  dipBuyCooldownHours: 72,
  profitTakeEnabled: true,
  profitTakeTier1Pct: 8, profitTakeTier1TrimPct: 25,
  profitTakeTier2Pct: 15, profitTakeTier2TrimPct: 30,
  profitTakeTier3Pct: 25, profitTakeTier3TrimPct: 30,
  minHoldPct: 15,
  lossCutEnabled: true,
  lossCutTier1Pct: 8, lossCutTier1SellPct: 30,
  lossCutTier2Pct: 15, lossCutTier2SellPct: 50,
  lossCutTier3Pct: 25, lossCutTier3SellPct: 100,
  lossCutMinHoldDays: 2,
  marketRegimeEnabled: true, maxSectorPct: 30,
  earningsAvoidEnabled: true, earningsBlackoutDays: 3,
  kellyAdaptiveEnabled: false,
};

export async function loadConfig(): Promise<AutoTraderConfig> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('auto_trader_config')
    .select('*')
    .eq('id', 'default')
    .single();

  if (error || !data) return DEFAULT_CONFIG;

  return {
    enabled: data.enabled ?? DEFAULT_CONFIG.enabled,
    maxPositions: data.max_positions ?? DEFAULT_CONFIG.maxPositions,
    positionSize: Number(data.position_size) || DEFAULT_CONFIG.positionSize,
    minScannerConfidence: data.min_scanner_confidence ?? DEFAULT_CONFIG.minScannerConfidence,
    minFAConfidence: data.min_fa_confidence ?? DEFAULT_CONFIG.minFAConfidence,
    minSuggestedFindsConviction: data.min_suggested_finds_conviction ?? DEFAULT_CONFIG.minSuggestedFindsConviction,
    accountId: data.account_id ?? DEFAULT_CONFIG.accountId,
    dayTradeAutoClose: data.day_trade_auto_close ?? DEFAULT_CONFIG.dayTradeAutoClose,
    maxTotalAllocation: Number(data.max_total_allocation) || DEFAULT_CONFIG.maxTotalAllocation,
    maxDailyDeployment: Number(data.max_daily_deployment) || DEFAULT_CONFIG.maxDailyDeployment,
    useDynamicSizing: data.use_dynamic_sizing ?? DEFAULT_CONFIG.useDynamicSizing,
    portfolioValue: Number(data.portfolio_value) || DEFAULT_CONFIG.portfolioValue,
    baseAllocationPct: Number(data.base_allocation_pct) || DEFAULT_CONFIG.baseAllocationPct,
    maxPositionPct: Number(data.max_position_pct) || DEFAULT_CONFIG.maxPositionPct,
    riskPerTradePct: Number(data.risk_per_trade_pct) || DEFAULT_CONFIG.riskPerTradePct,
    dipBuyEnabled: data.dip_buy_enabled ?? DEFAULT_CONFIG.dipBuyEnabled,
    dipBuyTier1Pct: Number(data.dip_buy_tier1_pct) || DEFAULT_CONFIG.dipBuyTier1Pct,
    dipBuyTier1SizePct: Number(data.dip_buy_tier1_size_pct) || DEFAULT_CONFIG.dipBuyTier1SizePct,
    dipBuyTier2Pct: Number(data.dip_buy_tier2_pct) || DEFAULT_CONFIG.dipBuyTier2Pct,
    dipBuyTier2SizePct: Number(data.dip_buy_tier2_size_pct) || DEFAULT_CONFIG.dipBuyTier2SizePct,
    dipBuyTier3Pct: Number(data.dip_buy_tier3_pct) || DEFAULT_CONFIG.dipBuyTier3Pct,
    dipBuyTier3SizePct: Number(data.dip_buy_tier3_size_pct) || DEFAULT_CONFIG.dipBuyTier3SizePct,
    dipBuyCooldownHours: data.dip_buy_cooldown_hours ?? DEFAULT_CONFIG.dipBuyCooldownHours,
    profitTakeEnabled: data.profit_take_enabled ?? DEFAULT_CONFIG.profitTakeEnabled,
    profitTakeTier1Pct: Number(data.profit_take_tier1_pct) || DEFAULT_CONFIG.profitTakeTier1Pct,
    profitTakeTier1TrimPct: Number(data.profit_take_tier1_trim_pct) || DEFAULT_CONFIG.profitTakeTier1TrimPct,
    profitTakeTier2Pct: Number(data.profit_take_tier2_pct) || DEFAULT_CONFIG.profitTakeTier2Pct,
    profitTakeTier2TrimPct: Number(data.profit_take_tier2_trim_pct) || DEFAULT_CONFIG.profitTakeTier2TrimPct,
    profitTakeTier3Pct: Number(data.profit_take_tier3_pct) || DEFAULT_CONFIG.profitTakeTier3Pct,
    profitTakeTier3TrimPct: Number(data.profit_take_tier3_trim_pct) || DEFAULT_CONFIG.profitTakeTier3TrimPct,
    minHoldPct: Number(data.min_hold_pct) || DEFAULT_CONFIG.minHoldPct,
    lossCutEnabled: data.loss_cut_enabled ?? DEFAULT_CONFIG.lossCutEnabled,
    lossCutTier1Pct: Number(data.loss_cut_tier1_pct) || DEFAULT_CONFIG.lossCutTier1Pct,
    lossCutTier1SellPct: Number(data.loss_cut_tier1_sell_pct) || DEFAULT_CONFIG.lossCutTier1SellPct,
    lossCutTier2Pct: Number(data.loss_cut_tier2_pct) || DEFAULT_CONFIG.lossCutTier2Pct,
    lossCutTier2SellPct: Number(data.loss_cut_tier2_sell_pct) || DEFAULT_CONFIG.lossCutTier2SellPct,
    lossCutTier3Pct: Number(data.loss_cut_tier3_pct) || DEFAULT_CONFIG.lossCutTier3Pct,
    lossCutTier3SellPct: Number(data.loss_cut_tier3_sell_pct) || DEFAULT_CONFIG.lossCutTier3SellPct,
    lossCutMinHoldDays: data.loss_cut_min_hold_days ?? DEFAULT_CONFIG.lossCutMinHoldDays,
    marketRegimeEnabled: data.market_regime_enabled ?? DEFAULT_CONFIG.marketRegimeEnabled,
    maxSectorPct: Number(data.max_sector_pct) || DEFAULT_CONFIG.maxSectorPct,
    earningsAvoidEnabled: data.earnings_avoid_enabled ?? DEFAULT_CONFIG.earningsAvoidEnabled,
    earningsBlackoutDays: data.earnings_blackout_days ?? DEFAULT_CONFIG.earningsBlackoutDays,
    kellyAdaptiveEnabled: data.kelly_adaptive_enabled ?? DEFAULT_CONFIG.kellyAdaptiveEnabled,
  };
}

export async function saveConfigPartial(
  updates: Record<string, unknown>
): Promise<void> {
  const sb = getSupabase();
  await sb.from('auto_trader_config').upsert({
    id: 'default',
    ...updates,
    updated_at: new Date().toISOString(),
  });
}

// ── Paper Trades ─────────────────────────────────────────

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
  status: string;
  fill_price: number | null;
  close_price: number | null;
  pnl: number | null;
  pnl_percent: number | null;
  opened_at: string;
  filled_at: string | null;
  closed_at: string | null;
  close_reason: string | null;
  scanner_reason: string | null;
  fa_rationale: Record<string, string> | null;
  notes: string | null;
  created_at: string;
  in_play_score?: number | null;
  pass1_confidence?: number | null;
  entry_trigger_type?: string | null;
  r_multiple?: number | null;
  market_condition?: string | null;
  // Swing entry log (post-trade metrics — collect only)
  pct_distance_sma20_at_entry?: number | null;
  macd_histogram_slope_at_entry?: string | null;
  volume_vs_10d_avg_at_entry?: number | null;
  regime_alignment_at_entry?: string | null;
}

export type ExternalStrategySignalStatus =
  | 'PENDING'
  | 'EXECUTED'
  | 'FAILED'
  | 'SKIPPED'
  | 'EXPIRED'
  | 'CANCELLED';

export interface ExternalStrategySignal {
  id: string;
  source_name: string;
  source_url: string | null;
  strategy_video_id: string | null;
  strategy_video_heading: string | null;
  ticker: string;
  signal: 'BUY' | 'SELL';
  mode: 'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM';
  confidence: number;
  entry_price: number | null;
  stop_loss: number | null;
  target_price: number | null;
  position_size_override: number | null;
  execute_on_date: string;
  execute_at: string | null;
  expires_at: string | null;
  notes: string | null;
  status: ExternalStrategySignalStatus;
  failure_reason: string | null;
  executed_trade_id: string | null;
  executed_at: string | null;
  created_at: string;
  updated_at: string;
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
}

export interface StrategyClosedTradeOutcome {
  pnl: number | null;
  closed_at: string | null;
  opened_at: string | null;
}

function formatDateToEtIso(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find(p => p.type === 'year')?.value ?? '0000';
  const month = parts.find(p => p.type === 'month')?.value ?? '00';
  const day = parts.find(p => p.type === 'day')?.value ?? '00';
  return `${year}-${month}-${day}`;
}

export async function getActiveTrades(): Promise<PaperTrade[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('paper_trades')
    .select('*')
    .in('status', ['PENDING', 'SUBMITTED', 'FILLED', 'PARTIAL'])
    .order('opened_at', { ascending: false });
  if (error) throw new Error(`getActiveTrades: ${error.message}`);
  return (data ?? []) as PaperTrade[];
}

/** Get LONG_TERM exposure by tag (Gold Mine vs Compounders) for tag-level caps. */
export async function getLongTermExposureByTag(): Promise<{
  totalGoldMineExposure: number;
  totalCompounderExposure: number;
  longTermTotal: number;
}> {
  const activeTrades = await getActiveTrades();
  const longTerm = activeTrades.filter(t => t.mode === 'LONG_TERM');

  const tagByTicker = new Map<string, 'Gold Mine' | 'Compounder'>();
  for (const t of longTerm) {
    if ((t.notes ?? '').startsWith('Dip buy')) continue;
    if (!tagByTicker.has(t.ticker)) {
      const isGoldMine = /Gold Mine/i.test((t.notes ?? '') + (t.scanner_reason ?? ''));
      tagByTicker.set(t.ticker, isGoldMine ? 'Gold Mine' : 'Compounder');
    }
  }

  let totalGoldMineExposure = 0;
  let totalCompounderExposure = 0;
  for (const t of longTerm) {
    const tag = tagByTicker.get(t.ticker);
    if (!tag) continue;
    const size = t.position_size ?? 0;
    if (tag === 'Gold Mine') totalGoldMineExposure += size;
    else totalCompounderExposure += size;
  }
  const longTermTotal = totalGoldMineExposure + totalCompounderExposure;
  return { totalGoldMineExposure, totalCompounderExposure, longTermTotal };
}

export async function hasActiveTrade(ticker: string): Promise<boolean> {
  const sb = getSupabase();
  const { count } = await sb
    .from('paper_trades')
    .select('id', { count: 'exact', head: true })
    .eq('ticker', ticker)
    .in('status', ['PENDING', 'SUBMITTED', 'FILLED', 'PARTIAL']);
  return (count ?? 0) > 0;
}

export async function countActivePositions(): Promise<number> {
  const sb = getSupabase();
  const { count } = await sb
    .from('paper_trades')
    .select('id', { count: 'exact', head: true })
    .in('status', ['PENDING', 'SUBMITTED', 'FILLED', 'PARTIAL']);
  return count ?? 0;
}

export async function createPaperTrade(
  trade: Record<string, unknown>
): Promise<PaperTrade> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('paper_trades')
    .insert(trade)
    .select()
    .single();
  if (error) throw new Error(`createPaperTrade: ${error.message}`);
  return data as PaperTrade;
}

export async function updatePaperTrade(
  id: string,
  updates: Record<string, unknown>
): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from('paper_trades')
    .update(updates)
    .eq('id', id);
  if (error) throw new Error(`updatePaperTrade: ${error.message}`);
}

// ── Swing Trade Metrics (diagnostics logging) ─────────────

export async function upsertSwingMetrics(params: {
  date: string;
  swing_signals?: number;
  swing_confident?: number;
  swing_skipped_distance?: number;
  swing_orders_placed?: number;
  swing_orders_expired?: number;
  swing_orders_filled?: number;
}): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.rpc('upsert_swing_metrics', {
    p_date: params.date,
    p_swing_signals: params.swing_signals ?? 0,
    p_swing_confident: params.swing_confident ?? 0,
    p_swing_skipped_distance: params.swing_skipped_distance ?? 0,
    p_swing_orders_placed: params.swing_orders_placed ?? 0,
    p_swing_orders_expired: params.swing_orders_expired ?? 0,
    p_swing_orders_filled: params.swing_orders_filled ?? 0,
  });
  if (error) console.warn('[SwingMetrics] upsert failed:', error.message);
}

// ── External Strategy Signals ────────────────────────────

export async function createExternalStrategySignal(
  signal: Record<string, unknown>
): Promise<ExternalStrategySignal> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('external_strategy_signals')
    .insert(signal)
    .select()
    .single();
  if (error) throw new Error(`createExternalStrategySignal: ${error.message}`);
  return data as ExternalStrategySignal;
}

export async function getExternalStrategySignals(
  limit = 100,
  status?: ExternalStrategySignalStatus
): Promise<ExternalStrategySignal[]> {
  const sb = getSupabase();
  let query = sb
    .from('external_strategy_signals')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw new Error(`getExternalStrategySignals: ${error.message}`);
  return (data ?? []) as ExternalStrategySignal[];
}

export async function findExternalStrategySignal(params: {
  sourceName: string;
  ticker: string;
  signal: 'BUY' | 'SELL';
  mode: 'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM';
  executeOnDate: string;
  strategyVideoId?: string;
}): Promise<ExternalStrategySignal | null> {
  const sb = getSupabase();
  let query = sb
    .from('external_strategy_signals')
    .select('*')
    .eq('source_name', params.sourceName)
    .eq('ticker', params.ticker.toUpperCase())
    .eq('signal', params.signal)
    .eq('mode', params.mode)
    .eq('execute_on_date', params.executeOnDate)
    .order('created_at', { ascending: false });

  if (params.strategyVideoId) {
    query = query.eq('strategy_video_id', params.strategyVideoId);
  }

  const { data, error } = await query.limit(1);

  if (error) throw new Error(`findExternalStrategySignal: ${error.message}`);
  return ((data ?? [])[0] as ExternalStrategySignal | undefined) ?? null;
}

export async function getDueExternalStrategySignals(
  now = new Date()
): Promise<ExternalStrategySignal[]> {
  const sb = getSupabase();
  const today = formatDateToEtIso(now);
  const { data, error } = await sb
    .from('external_strategy_signals')
    .select('*')
    .eq('status', 'PENDING')
    .lte('execute_on_date', today)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`getDueExternalStrategySignals: ${error.message}`);
  return (data ?? []) as ExternalStrategySignal[];
}

export async function updateExternalStrategySignal(
  id: string,
  updates: Record<string, unknown>
): Promise<void> {
  const sb = getSupabase();
  const payload = {
    ...updates,
    updated_at: new Date().toISOString(),
  };
  const { error } = await sb
    .from('external_strategy_signals')
    .update(payload)
    .eq('id', id);
  if (error) throw new Error(`updateExternalStrategySignal: ${error.message}`);
}

// ── Source Performance ───────────────────────────────────

export async function getStrategySourcePerformance(): Promise<StrategySourcePerformance[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('paper_trades')
    .select('strategy_source, strategy_source_url, status, pnl, fill_price')
    .not('strategy_source', 'is', null);
  if (error) throw new Error(`getStrategySourcePerformance: ${error.message}`);

  const trades = (data ?? []) as Array<{
    strategy_source: string | null;
    strategy_source_url: string | null;
    status: string;
    pnl: number | null;
    fill_price: number | null;
  }>;

  const bySource = new Map<string, {
    sourceUrl: string | null;
    totalTrades: number;
    activeTrades: number;
    wins: number;
    losses: number;
    closedCount: number;
    closedPnl: number;
    activeUnrealizedPnl: number;
  }>();

  const activeStatuses = new Set(['PENDING', 'SUBMITTED', 'FILLED', 'PARTIAL']);
  const closedStatuses = new Set(['STOPPED', 'TARGET_HIT', 'CLOSED']);

  for (const trade of trades) {
    const source = (trade.strategy_source ?? '').trim();
    if (!source) continue;
    const curr = bySource.get(source) ?? {
      sourceUrl: trade.strategy_source_url ?? null,
      totalTrades: 0,
      activeTrades: 0,
      wins: 0,
      losses: 0,
      closedCount: 0,
      closedPnl: 0,
      activeUnrealizedPnl: 0,
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
    }

    bySource.set(source, curr);
  }

  return [...bySource.entries()]
    .map(([source, s]) => {
      const totalPnl = s.closedPnl + s.activeUnrealizedPnl;
      return {
        source,
        sourceUrl: s.sourceUrl,
        totalTrades: s.totalTrades,
        activeTrades: s.activeTrades,
        wins: s.wins,
        losses: s.losses,
        winRate: s.closedCount > 0 ? (s.wins / s.closedCount) * 100 : 0,
        totalPnl,
        avgPnl: s.closedCount > 0 ? s.closedPnl / s.closedCount : 0,
      };
    })
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

export async function getRecentClosedStrategyOutcomes(params: {
  sourceName: string;
  mode?: 'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM';
  strategyVideoId?: string | null;
  limit?: number;
}): Promise<StrategyClosedTradeOutcome[]> {
  const sb = getSupabase();
  let query = sb
    .from('paper_trades')
    .select('pnl, closed_at, opened_at')
    .eq('strategy_source', params.sourceName)
    .in('status', ['STOPPED', 'TARGET_HIT', 'CLOSED'])
    .not('fill_price', 'is', null)
    .order('closed_at', { ascending: false, nullsFirst: false })
    .order('opened_at', { ascending: false });

  if (params.mode) {
    query = query.eq('mode', params.mode);
  }

  if (params.strategyVideoId) {
    query = query.eq('strategy_video_id', params.strategyVideoId);
  }

  const { data, error } = await query.limit(Math.max(1, Math.min(50, params.limit ?? 10)));
  if (error) throw new Error(`getRecentClosedStrategyOutcomes: ${error.message}`);
  return (data ?? []) as StrategyClosedTradeOutcome[];
}

// ── Auto Trade Events ────────────────────────────────────

export async function createAutoTradeEvent(
  event: Record<string, unknown>
): Promise<void> {
  try {
    const sb = getSupabase();
    await sb.from('auto_trade_events').insert(event);
  } catch {
    // fire-and-forget
  }
}

export async function getRecentDipBuyEvents(
  ticker: string
): Promise<{ created_at: string }[]> {
  const sb = getSupabase();
  const { data } = await sb
    .from('auto_trade_events')
    .select('created_at')
    .eq('ticker', ticker)
    .eq('source', 'dip_buy')
    .eq('action', 'executed')
    .order('created_at', { ascending: false })
    .limit(1);
  return data ?? [];
}

export async function getPastTrimEvents(
  ticker: string
): Promise<{ metadata: Record<string, unknown> }[]> {
  const sb = getSupabase();
  const { data } = await sb
    .from('auto_trade_events')
    .select('metadata')
    .eq('ticker', ticker)
    .eq('source', 'profit_take')
    .eq('action', 'executed');
  return (data ?? []) as { metadata: Record<string, unknown> }[];
}

export async function getPastLossCutEvents(
  ticker: string
): Promise<{ metadata: Record<string, unknown> }[]> {
  const sb = getSupabase();
  const { data } = await sb
    .from('auto_trade_events')
    .select('metadata')
    .eq('ticker', ticker)
    .eq('source', 'loss_cut')
    .eq('action', 'executed');
  return (data ?? []) as { metadata: Record<string, unknown> }[];
}

// ── Portfolio Snapshot ───────────────────────────────────

export async function savePortfolioSnapshot(
  snapshot: Record<string, unknown>
): Promise<void> {
  const sb = getSupabase();
  await sb.from('portfolio_snapshots').insert(snapshot);
}

// ── Performance ──────────────────────────────────────────

export async function getPerformance(): Promise<{
  total_trades: number;
  win_rate: number;
  avg_win: number;
  avg_loss: number;
} | null> {
  const sb = getSupabase();
  const { data } = await sb
    .from('trade_performance')
    .select('total_trades, win_rate, avg_win, avg_loss')
    .limit(1)
    .single();
  return data as { total_trades: number; win_rate: number; avg_win: number; avg_loss: number } | null;
}
