/**
 * Frontend API client for the Options Wheel Engine.
 * Talks directly to Supabase for watchlist + scan results + positions.
 */

import { createClient } from '@supabase/supabase-js';
import { CLOSED_STATUSES } from '../../../shared/trade-status-sets.ts';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const supabase = createClient(supabaseUrl, supabaseKey);

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const FINNHUB_KEY = import.meta.env.VITE_FINNHUB_API_KEY as string;

/** Fetches company name + sector from Finnhub and returns a one-line description. */
export async function lookupTickerDescription(ticker: string): Promise<string | null> {
  if (!FINNHUB_KEY) return null;
  try {
    const res = await fetch(
      `${FINNHUB_BASE}/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`
    );
    if (!res.ok) return null;
    const p = await res.json();
    if (!p?.name) return null;
    return p.finnhubIndustry ? `${p.name} — ${p.finnhubIndustry}` : p.name;
  } catch {
    return null;
  }
}

export interface TickerQuote {
  price: number;
  change: number;
  changePercent: number;
}

/** Fetches live quotes for a list of tickers from Finnhub in parallel. */
export async function fetchWatchlistQuotes(tickers: string[]): Promise<Map<string, TickerQuote>> {
  const result = new Map<string, TickerQuote>();
  if (!FINNHUB_KEY || tickers.length === 0) return result;

  const fetches = tickers.map(async (ticker) => {
    try {
      const res = await fetch(
        `${FINNHUB_BASE}/quote?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`
      );
      if (!res.ok) return;
      const q = await res.json();
      if (typeof q?.c === 'number' && q.c > 0) {
        result.set(ticker, { price: q.c, change: q.d ?? 0, changePercent: q.dp ?? 0 });
      }
    } catch {
      // silent — tile just won't show price
    }
  });

  await Promise.all(fetches);
  return result;
}

// ── Types ────────────────────────────────────────────────

export type WatchlistTierType = 'STABLE' | 'GROWTH' | 'HIGH_VOL';

export interface WatchlistCandidate {
  ticker: string;
  name: string | null;
  price: number | null;
  beta: number | null;
  market_cap_b: number | null;
  pct_from_52w_high: number | null;
  tier: WatchlistTierType;
  industry: string | null;
  reason: string | null;
  dismissed: boolean;
  scanned_at: string;
}

export interface WatchlistTicker {
  id: string;
  ticker: string;
  added_by: string;   // 'user' | 'manual' | 'system' | 'steady_compounders'
  min_price: number | null;
  notes: string | null;
  active: boolean;
  created_at: string;
  tier: WatchlistTierType;
  sector: string | null;
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
  bb_lower?: number | null;
  bb_upper?: number | null;
  bb_signal?: 'at_lower' | 'near_lower' | null;
}

export interface OpenOptionsPosition {
  id: string;
  ticker: string;
  mode: 'OPTIONS_PUT' | 'OPTIONS_CALL';
  option_strike: number;
  option_expiry: string;
  option_premium: number;
  option_contracts: number | null;
  option_capital_req: number;
  option_prob_profit: number;
  option_iv_rank: number | null;
  option_annual_yield: number;
  option_net_price: number;
  option_delta: number | null;
  option_assigned: boolean;
  status: string;
  close_reason: string | null;
  pnl: number | null;
  opened_at: string;
  closed_at: string | null;
  notes: string | null;
  scanner_reason: string | null;
  ib_order_id: string | null;
}

export interface OptionsMonthlyStats {
  premiumCollected: number;
  wins: number;
  losses: number;
  winRate: number;
  openPositions: number;
  annualizedReturn: number;
  projectedMonthlyIncome: number; // total premium locked in from all currently open puts
  openPremiumAtRisk: number;      // cash already received from open positions, not yet earned
  expiredWorthless: number;       // count of trades that expired OTM this month
  scalpPnl: number;               // realized P&L from OPTIONS_SCALP trades this month
  scalpTrades: number;            // count of closed scalp trades this month
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
    added_by: 'user',
    notes: notes ?? null,
    active: true,
  });
  if (error) throw error;
}

export async function removeFromOptionsWatchlist(ticker: string): Promise<void> {
  const { error } = await supabase
    .from('options_watchlist')
    .delete()
    .eq('ticker', ticker.toUpperCase());
  if (error) throw error;
}

export async function getWatchlistCandidates(): Promise<WatchlistCandidate[]> {
  const { data, error } = await supabase
    .from('options_watchlist_candidates')
    .select('*')
    .eq('dismissed', false)
    .order('tier')
    .order('pct_from_52w_high', { ascending: false });
  if (error) throw error;
  return (data ?? []) as WatchlistCandidate[];
}

export async function dismissWatchlistCandidate(ticker: string): Promise<void> {
  const { error } = await supabase
    .from('options_watchlist_candidates')
    .update({ dismissed: true })
    .eq('ticker', ticker.toUpperCase());
  if (error) throw error;
}

export async function promoteWatchlistCandidate(ticker: string, notes?: string): Promise<void> {
  await addToOptionsWatchlist(ticker, notes);
  await supabase
    .from('options_watchlist_candidates')
    .update({ added_at: new Date().toISOString(), dismissed: true })
    .eq('ticker', ticker.toUpperCase());
}

export async function updateOptionsWatchlistNotes(ticker: string, notes: string): Promise<void> {
  const { error } = await supabase
    .from('options_watchlist')
    .update({ notes: notes.trim() || null })
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
    .select('id, ticker, mode, option_strike, option_expiry, option_premium, option_contracts, option_capital_req, option_prob_profit, option_iv_rank, option_annual_yield, option_net_price, option_delta, option_assigned, status, close_reason, pnl, opened_at, closed_at, notes, scanner_reason, ib_order_id')
    .in('mode', ['OPTIONS_PUT', 'OPTIONS_CALL'])
    .in('status', ['FILLED', 'PARTIAL'])
    .order('option_expiry', { ascending: true });
  if (error) throw error;
  return (data ?? []) as OpenOptionsPosition[];
}

/** Fetch the options capital budget cap from auto_trader_config. */
export async function getOptionsMaxAllocation(): Promise<number | null> {
  const { data } = await supabase
    .from('auto_trader_config')
    .select('max_total_allocation')
    .eq('id', 'default')
    .single();
  return (data as { max_total_allocation?: number } | null)?.max_total_allocation ?? null;
}

// ── Closed / History ─────────────────────────────────────

export async function getClosedOptionsPositions(limit = 50): Promise<OpenOptionsPosition[]> {
  const { data, error } = await supabase
    .from('paper_trades')
    .select('id, ticker, mode, option_strike, option_expiry, option_premium, option_capital_req, option_prob_profit, option_iv_rank, option_annual_yield, option_net_price, option_delta, option_assigned, status, close_reason, pnl, opened_at, closed_at, notes, scanner_reason')
    .in('mode', ['OPTIONS_PUT', 'OPTIONS_CALL'])
    .in('status', [...CLOSED_STATUSES])
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

  const [{ data: closed }, { data: open }, { data: scalps }] = await Promise.all([
    supabase
      .from('paper_trades')
      .select('pnl, option_capital_req, close_reason')
      .in('mode', ['OPTIONS_PUT', 'OPTIONS_CALL'])
      .in('status', [...CLOSED_STATUSES])
      .gte('closed_at', monthStart.toISOString()),
    supabase
      .from('paper_trades')
      .select('id, option_premium, option_contracts')
      .in('mode', ['OPTIONS_PUT', 'OPTIONS_CALL'])
      .in('status', ['FILLED', 'PARTIAL']),
    supabase
      .from('paper_trades')
      .select('pnl')
      .eq('mode', 'OPTIONS_SCALP')
      .in('status', [...CLOSED_STATUSES])
      .gte('closed_at', monthStart.toISOString()),
  ]);

  // Only count trades with meaningful P&L (> $1) — excludes spurious $0 closes
  const trades = (closed ?? []).filter((t: { pnl: number | null }) => Math.abs(t.pnl ?? 0) > 1);
  const wins = trades.filter((t: { pnl: number | null }) => (t.pnl ?? 0) > 0);
  const losses = trades.filter((t: { pnl: number | null }) => (t.pnl ?? 0) < 0);
  const expiredWorthless = (closed ?? []).filter((t: { close_reason: string | null }) => t.close_reason === 'expired_worthless').length;

  const premiumCollected = trades.reduce((s: number, t: { pnl: number | null }) => s + (t.pnl ?? 0), 0);
  const totalCapital = trades.reduce((s: number, t: { option_capital_req: number | null }) => s + (t.option_capital_req ?? 0), 0);
  const daysInMonth = new Date().getDate();
  const annualizedReturn = totalCapital > 0 ? (premiumCollected / totalCapital) * (365 / daysInMonth) * 100 : 0;

  const projectedMonthlyIncome = (open ?? []).reduce((sum: number, t: { option_premium: number | null; option_contracts: number | null }) => {
    return sum + (t.option_premium ?? 0) * (t.option_contracts ?? 1) * 100;
  }, 0);

  const scalpTrades = (scalps ?? []).filter((t: { pnl: number | null }) => Math.abs(t.pnl ?? 0) > 1);
  const scalpPnl = scalpTrades.reduce((s: number, t: { pnl: number | null }) => s + (t.pnl ?? 0), 0);

  return {
    premiumCollected,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    openPositions: (open ?? []).length,
    annualizedReturn,
    projectedMonthlyIncome,
    openPremiumAtRisk: projectedMonthlyIncome,
    expiredWorthless,
    scalpPnl,
    scalpTrades: scalpTrades.length,
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

// ── Options Scalps ───────────────────────────────────────

export interface ScalpTrade {
  id: string;
  ticker: string;
  mode: string;
  status: string;
  option_strike: number | null;
  option_expiry: string | null;
  option_premium: number | null;
  option_contracts: number | null;
  fill_price: number | null;
  pnl: number | null;
  close_reason: string | null;
  opened_at: string;
  closed_at: string | null;
  notes: string | null;
  scanner_reason: string | null;
}

const SCALP_SELECT = 'id, ticker, mode, status, option_strike, option_expiry, option_premium, option_contracts, fill_price, pnl, close_reason, opened_at, closed_at, notes, scanner_reason';

export async function getOpenScalpTrades(): Promise<ScalpTrade[]> {
  const { data, error } = await supabase
    .from('paper_trades')
    .select(SCALP_SELECT)
    .eq('mode', 'OPTIONS_SCALP')
    .in('status', ['FILLED', 'PARTIAL'])
    .order('opened_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ScalpTrade[];
}

export async function getClosedScalpTrades(limit = 40): Promise<ScalpTrade[]> {
  const { data, error } = await supabase
    .from('paper_trades')
    .select(SCALP_SELECT)
    .eq('mode', 'OPTIONS_SCALP')
    .in('status', [...CLOSED_STATUSES])
    // Exclude exercise-cover mechanics records (pnl=0 cover buys from reconcileIBShorts).
    // Must use OR IS NULL — plain .neq() drops NULL close_reason rows too (SQL NULL != x is UNKNOWN).
    .or('close_reason.neq.ib_reconciliation_cover,close_reason.is.null')
    .order('closed_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as ScalpTrade[];
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
    .or('mode.in.(OPTIONS_PUT,OPTIONS_CALL,CREDIT_SPREAD,OPTIONS_SCALP,CALENDAR_SPREAD,OPTIONS_LEAP),and(mode.is.null,message.ilike.%option%)')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return [];
  return (data ?? []) as OptionsActivityEvent[];
}

// ── Credit Spreads ───────────────────────────────────────

export interface CreditSpreadPosition {
  id: string;
  ticker: string;
  mode: string;
  status: string;
  spread_type: string | null;
  spread_short_strike: number | null;
  spread_long_strike: number | null;
  spread_width: number | null;
  spread_net_credit: number | null;
  spread_credit_pct: number | null;
  spread_max_loss: number | null;
  spread_max_gain: number | null;
  option_expiry: string | null;
  option_contracts: number | null;
  option_delta: number | null;
  pnl: number | null;
  opened_at: string;
  closed_at: string | null;
  close_reason: string | null;
  notes: string | null;
  scanner_reason: string | null;
}

export async function getOpenCreditSpreads(): Promise<CreditSpreadPosition[]> {
  const { data, error } = await supabase
    .from('paper_trades')
    .select('id, ticker, mode, status, spread_type, spread_short_strike, spread_long_strike, spread_width, spread_net_credit, spread_credit_pct, spread_max_loss, spread_max_gain, option_expiry, option_contracts, option_delta, pnl, opened_at, closed_at, close_reason, notes, scanner_reason')
    .eq('mode', 'CREDIT_SPREAD')
    .in('status', ['FILLED', 'PARTIAL'])
    .order('option_expiry', { ascending: true });
  if (error) throw error;
  return (data ?? []) as CreditSpreadPosition[];
}

export async function getClosedCreditSpreads(limit = 20): Promise<CreditSpreadPosition[]> {
  const { data, error } = await supabase
    .from('paper_trades')
    .select('id, ticker, mode, status, spread_type, spread_short_strike, spread_long_strike, spread_width, spread_net_credit, spread_credit_pct, spread_max_loss, spread_max_gain, option_expiry, option_contracts, option_delta, pnl, opened_at, closed_at, close_reason, notes, scanner_reason')
    .eq('mode', 'CREDIT_SPREAD')
    .in('status', [...CLOSED_STATUSES])
    .order('closed_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as CreditSpreadPosition[];
}
