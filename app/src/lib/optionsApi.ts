/**
 * Frontend API client for the Options Wheel Engine.
 * Talks directly to Supabase for watchlist + scan results + positions.
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const supabase = createClient(supabaseUrl, supabaseKey);

// ── Types ────────────────────────────────────────────────

export interface WatchlistTicker {
  id: string;
  ticker: string;
  added_by: string;
  min_price: number | null;
  notes: string | null;
  active: boolean;
  created_at: string;
}

export interface OptionsScanOpportunity {
  id: string;
  ticker: string;
  scan_date: string;
  signal: 'SELL_PUT' | 'SELL_CALL' | 'NO_SIGNAL';
  strike: number;
  expiry: string;
  premium: number;
  net_price: number;
  delta: number;
  iv_rank: number | null;
  prob_profit: number;
  capital_req: number;
  annual_yield: number;
  checks_passed: Record<string, boolean | string>;
  skip_reason: string | null;
  bear_mode?: boolean;
  leverage_factor?: number;
  dip_entry?: boolean;
  contracts?: number;
}

export interface OpenOptionsPosition {
  id: string;
  ticker: string;
  mode: 'OPTIONS_PUT' | 'OPTIONS_CALL';
  option_strike: number;
  option_expiry: string;
  option_premium: number;
  option_capital_req: number;
  option_prob_profit: number;
  option_iv_rank: number | null;
  option_annual_yield: number;
  option_net_price: number;
  option_assigned: boolean;
  status: string;
  close_reason: string | null;
  pnl: number | null;
  opened_at: string;
  closed_at: string | null;
  notes: string | null;
}

export interface OptionsMonthlyStats {
  premiumCollected: number;
  wins: number;
  losses: number;
  winRate: number;
  openPositions: number;
  annualizedReturn: number;
}

// ── Watchlist ────────────────────────────────────────────

export async function getOptionsWatchlist(): Promise<WatchlistTicker[]> {
  const { data, error } = await supabase
    .from('options_watchlist')
    .select('*')
    .order('ticker');
  if (error) throw error;
  return (data ?? []) as WatchlistTicker[];
}

export async function addToOptionsWatchlist(ticker: string, notes?: string): Promise<void> {
  const { error } = await supabase.from('options_watchlist').insert({
    ticker: ticker.toUpperCase(),
    added_by: 'manual',
    notes: notes ?? null,
    active: true,
  });
  if (error) throw error;
}

export async function removeFromOptionsWatchlist(ticker: string): Promise<void> {
  const { error } = await supabase
    .from('options_watchlist')
    .update({ active: false })
    .eq('ticker', ticker.toUpperCase());
  if (error) throw error;
}

// ── Scan Results ─────────────────────────────────────────

export async function getLatestOptionsScan(): Promise<OptionsScanOpportunity[]> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('options_scan_results')
    .select('*')
    .eq('scan_date', today)
    .neq('signal', 'NO_SIGNAL')
    .order('annual_yield', { ascending: false });
  if (error) throw error;
  return (data ?? []) as OptionsScanOpportunity[];
}

export async function getSkippedOptionsScan(): Promise<OptionsScanOpportunity[]> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('options_scan_results')
    .select('*')
    .eq('scan_date', today)
    .eq('signal', 'NO_SIGNAL')
    .order('ticker');
  if (error) throw error;
  return (data ?? []) as OptionsScanOpportunity[];
}

export async function getRecentOptionsScan(daysBack = 3): Promise<OptionsScanOpportunity[]> {
  const from = new Date(Date.now() - daysBack * 86400_000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('options_scan_results')
    .select('*')
    .gte('scan_date', from)
    .neq('signal', 'NO_SIGNAL')
    .order('scan_date', { ascending: false })
    .order('annual_yield', { ascending: false });
  if (error) throw error;
  return (data ?? []) as OptionsScanOpportunity[];
}

// ── Open Positions ────────────────────────────────────────

export async function getOpenOptionsPositions(): Promise<OpenOptionsPosition[]> {
  const { data, error } = await supabase
    .from('paper_trades')
    .select('id, ticker, mode, option_strike, option_expiry, option_premium, option_capital_req, option_prob_profit, option_iv_rank, option_annual_yield, option_net_price, option_assigned, status, pnl, opened_at, closed_at, notes')
    .in('mode', ['OPTIONS_PUT', 'OPTIONS_CALL'])
    .in('status', ['PENDING', 'SUBMITTED', 'FILLED', 'PARTIAL'])
    .order('option_expiry', { ascending: true });
  if (error) throw error;
  return (data ?? []) as OpenOptionsPosition[];
}

// ── Closed / History ─────────────────────────────────────

export async function getClosedOptionsPositions(limit = 50): Promise<OpenOptionsPosition[]> {
  const { data, error } = await supabase
    .from('paper_trades')
    .select('id, ticker, mode, option_strike, option_expiry, option_premium, option_capital_req, option_prob_profit, option_iv_rank, option_annual_yield, option_net_price, option_assigned, status, close_reason, pnl, opened_at, closed_at, notes')
    .in('mode', ['OPTIONS_PUT', 'OPTIONS_CALL'])
    .in('status', ['CLOSED', 'TARGET_HIT', 'STOPPED'])
    .order('closed_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as OpenOptionsPosition[];
}

// ── Monthly Stats ─────────────────────────────────────────

export async function getOptionsMonthlyStats(): Promise<OptionsMonthlyStats> {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [{ data: closed }, { data: open }] = await Promise.all([
    supabase
      .from('paper_trades')
      .select('pnl, option_capital_req')
      .in('mode', ['OPTIONS_PUT', 'OPTIONS_CALL'])
      .in('status', ['CLOSED', 'TARGET_HIT', 'STOPPED'])
      .gte('closed_at', monthStart.toISOString()),
    supabase
      .from('paper_trades')
      .select('id')
      .in('mode', ['OPTIONS_PUT', 'OPTIONS_CALL'])
      .in('status', ['FILLED', 'PARTIAL', 'PENDING', 'SUBMITTED']),
  ]);

  // Only count trades with meaningful P&L (> $1) — excludes spurious $0 closes
  const trades = (closed ?? []).filter(t => Math.abs(t.pnl ?? 0) > 1);
  const wins = trades.filter(t => (t.pnl ?? 0) > 0);
  const losses = trades.filter(t => (t.pnl ?? 0) < 0);
  const premiumCollected = wins.reduce((s: number, t: { pnl: number | null }) => s + (t.pnl ?? 0), 0);
  const totalCapital = trades.reduce((s: number, t: { option_capital_req: number | null }) => s + (t.option_capital_req ?? 0), 0);
  const daysInMonth = new Date().getDate();
  const annualizedReturn = totalCapital > 0 ? (premiumCollected / totalCapital) * (365 / daysInMonth) * 100 : 0;

  return {
    premiumCollected,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    openPositions: (open ?? []).length,
    annualizedReturn,
  };
}

// ── Auto-Trade Settings ───────────────────────────────────

export async function getOptionsAutoTradeEnabled(): Promise<boolean> {
  const { data } = await supabase
    .from('auto_trader_config')
    .select('options_auto_trade_enabled')
    .eq('id', 'default')
    .single();
  return (data as { options_auto_trade_enabled?: boolean } | null)?.options_auto_trade_enabled ?? false;
}

export async function setOptionsAutoTradeEnabled(enabled: boolean): Promise<void> {
  const { error } = await supabase
    .from('auto_trader_config')
    .update({ options_auto_trade_enabled: enabled, updated_at: new Date().toISOString() })
    .eq('id', 'default');
  if (error) throw error;
}

// ── Paper Trade Manually ──────────────────────────────────

export async function paperTradeOptionManually(opp: OptionsScanOpportunity): Promise<void> {
  const { error } = await supabase.from('paper_trades').insert({
    ticker: opp.ticker,
    mode: 'OPTIONS_PUT',
    signal: 'SELL',
    entry_price: null,
    fill_price: null,
    quantity: 1,
    position_size: opp.capital_req,
    status: 'FILLED',
    filled_at: new Date().toISOString(),
    opened_at: new Date().toISOString(),
    option_strike: opp.strike,
    option_expiry: opp.expiry,
    option_premium: opp.premium,
    option_contracts: 1,
    option_delta: opp.delta,
    option_iv_rank: opp.iv_rank,
    option_prob_profit: opp.prob_profit,
    option_net_price: opp.net_price,
    option_capital_req: opp.capital_req,
    option_annual_yield: opp.annual_yield,
    notes: `Sell put: $${opp.strike} strike, expiry ${opp.expiry}, collect $${Math.round(opp.premium * 100)}`,
    scanner_reason: `IV Rank: ${opp.iv_rank ?? 'n/a'}, Prob Profit: ${opp.prob_profit?.toFixed(0)}%, Annual yield: ${opp.annual_yield?.toFixed(1)}%`,
  });
  if (error) throw error;
}

// ── Activity Log ─────────────────────────────────────────

export interface OptionsActivityEvent {
  id: string;
  ticker: string;
  event_type: 'info' | 'success' | 'warning' | 'error';
  message: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/** Fetch recent options-wheel activity events (newest first) */
export async function getOptionsActivityLog(limit = 50): Promise<OptionsActivityEvent[]> {
  const { data, error } = await supabase
    .from('auto_trade_events')
    .select('id, ticker, event_type, message, metadata, created_at')
    .in('mode', ['OPTIONS_PUT', 'OPTIONS_CALL'])
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return [];
  return (data ?? []) as OptionsActivityEvent[];
}
