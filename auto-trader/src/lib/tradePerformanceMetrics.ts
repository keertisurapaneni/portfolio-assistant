/**
 * Rolling attribution metrics from trade_performance_log.
 * Analytics only — does not modify trading logic.
 */

import { getSupabase } from './supabase.js';

export interface TradePerformanceRow {
  trade_id: string;
  ticker: string;
  strategy: string;
  tag: string | null;
  entry_datetime: string;
  exit_datetime: string;
  entry_price: number | null;
  exit_price: number | null;
  qty: number | null;
  notional_at_entry: number | null;
  realized_pnl: number | null;
  realized_return_pct: number | null;
  days_held: number | null;
  regime_at_entry: { spy_above_50?: boolean; spy_above_200?: boolean; vix_bucket?: string } | null;
  regime_at_exit: { spy_above_50?: boolean; spy_above_200?: boolean; vix_bucket?: string } | null;
}

function regimeBucket(row: TradePerformanceRow): string {
  const r = row.regime_at_entry ?? row.regime_at_exit;
  if (!r) return 'unknown';
  const above200 = r.spy_above_200 ? 'above200' : 'below200';
  const vix = r.vix_bucket ?? 'unknown';
  return `${above200}_${vix}`;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function stdev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

export interface GroupMetrics {
  count_trades_closed: number;
  win_rate: number;
  avg_return_pct: number;
  median_return_pct: number;
  stdev_return_pct: number;
  profit_factor: number;
  avg_days_held: number;
  total_pnl: number;
}

export interface PerformanceSummary {
  asOf: string;
  rolling30d: {
    byStrategy: Record<string, GroupMetrics>;
    byTag: Record<string, GroupMetrics>;
    byRegime: Record<string, GroupMetrics>;
    overall: GroupMetrics & { portfolio_realized_return_pct: number };
  };
  rolling90d: {
    byStrategy: Record<string, GroupMetrics>;
    byTag: Record<string, GroupMetrics>;
    byRegime: Record<string, GroupMetrics>;
    overall: GroupMetrics & { portfolio_realized_return_pct: number };
  };
}

function computeGroupMetrics(rows: TradePerformanceRow[]): GroupMetrics {
  const returns = rows.map(r => r.realized_return_pct).filter((x): x is number => x != null);
  const pnls = rows.map(r => r.realized_pnl).filter((x): x is number => x != null);
  const daysHeld = rows.map(r => r.days_held).filter((x): x is number => x != null);
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p < 0);
  const sumWins = wins.reduce((a, b) => a + b, 0);
  const sumLosses = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = sumLosses > 0 ? sumWins / sumLosses : (sumWins > 0 ? Infinity : 0);
  return {
    count_trades_closed: rows.length,
    win_rate: rows.length > 0 ? wins.length / rows.length : 0,
    avg_return_pct: returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0,
    median_return_pct: median(returns),
    stdev_return_pct: stdev(returns),
    profit_factor: profitFactor === Infinity ? 999 : Math.round(profitFactor * 100) / 100,
    avg_days_held: daysHeld.length > 0 ? daysHeld.reduce((a, b) => a + b, 0) / daysHeld.length : 0,
    total_pnl: pnls.reduce((a, b) => a + b, 0),
  };
}

function aggregateByGroup(
  rows: TradePerformanceRow[],
  groupKey: (r: TradePerformanceRow) => string
): Record<string, GroupMetrics> {
  const byKey = new Map<string, TradePerformanceRow[]>();
  for (const r of rows) {
    const k = groupKey(r);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r);
  }
  const out: Record<string, GroupMetrics> = {};
  for (const [k, arr] of byKey) {
    out[k] = computeGroupMetrics(arr);
  }
  return out;
}

function portfolioRealizedReturnPct(rows: TradePerformanceRow[]): number {
  const totalNotional = rows.reduce((s, r) => s + (r.notional_at_entry ?? 0), 0);
  const totalPnl = rows.reduce((s, r) => s + (r.realized_pnl ?? 0), 0);
  return totalNotional > 0 ? (totalPnl / totalNotional) * 100 : 0;
}

/** Get rolling 30d and 90d performance summary. */
export async function getPerformanceSummary(options?: { asOf?: Date }): Promise<PerformanceSummary> {
  const asOf = options?.asOf ?? new Date();
  const asOfStr = asOf.toISOString();
  const d30 = new Date(asOf);
  d30.setDate(d30.getDate() - 30);
  const d90 = new Date(asOf);
  d90.setDate(d90.getDate() - 90);

  const sb = getSupabase();
  const { data, error } = await sb
    .from('trade_performance_log')
    .select('*')
    .lte('exit_datetime', asOfStr)
    .gte('exit_datetime', d90.toISOString());

  if (error) throw new Error(`getPerformanceSummary: ${error.message}`);
  const all = (data ?? []) as TradePerformanceRow[];

  const rows30 = all.filter(r => new Date(r.exit_datetime) >= d30);
  const rows90 = all;

  const byStrategy30 = aggregateByGroup(rows30, r => r.strategy);
  const byTag30 = aggregateByGroup(rows30.filter(r => r.tag), r => r.tag!);
  const byRegime30 = aggregateByGroup(rows30, regimeBucket);

  const byStrategy90 = aggregateByGroup(rows90, r => r.strategy);
  const byTag90 = aggregateByGroup(rows90.filter(r => r.tag), r => r.tag!);
  const byRegime90 = aggregateByGroup(rows90, regimeBucket);

  const overall30 = computeGroupMetrics(rows30);
  const overall90 = computeGroupMetrics(rows90);

  return {
    asOf: asOfStr,
    rolling30d: {
      byStrategy: byStrategy30,
      byTag: byTag30,
      byRegime: byRegime30,
      overall: {
        ...overall30,
        portfolio_realized_return_pct: portfolioRealizedReturnPct(rows30),
      },
    },
    rolling90d: {
      byStrategy: byStrategy90,
      byTag: byTag90,
      byRegime: byRegime90,
      overall: {
        ...overall90,
        portfolio_realized_return_pct: portfolioRealizedReturnPct(rows90),
      },
    },
  };
}

export type WindowKey = '7d' | '30d' | '90d';

/** Get performance for a specific window. Returns empty data + warnings when table missing or sparse. */
export async function getPerformanceForWindow(
  window: WindowKey,
  options?: { asOf?: Date }
): Promise<{
  asOf: string;
  overall: GroupMetrics & { portfolio_realized_return_pct: number };
  byStrategy: Record<string, GroupMetrics>;
  byTag: Record<string, GroupMetrics>;
  byRegime: Record<string, GroupMetrics>;
  recentClosedTrades: TradePerformanceRow[];
  warnings: string[];
}> {
  const asOf = options?.asOf ?? new Date();
  const asOfStr = asOf.toISOString();
  const days = window === '7d' ? 7 : window === '30d' ? 30 : 90;
  const from = new Date(asOf);
  from.setDate(from.getDate() - days);

  const warnings: string[] = [];
  const emptyOverall: GroupMetrics & { portfolio_realized_return_pct: number } = {
    count_trades_closed: 0,
    win_rate: 0,
    avg_return_pct: 0,
    median_return_pct: 0,
    stdev_return_pct: 0,
    profit_factor: 0,
    avg_days_held: 0,
    total_pnl: 0,
    portfolio_realized_return_pct: 0,
  };

  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('trade_performance_log')
      .select('*')
      .gte('exit_datetime', from.toISOString())
      .lte('exit_datetime', asOfStr)
      .order('exit_datetime', { ascending: false })
      .limit(200);

    if (error) {
      if (error.code === '42P01' || error.message?.includes('does not exist')) {
        warnings.push('Performance log table not yet available. Run migrations and close some trades.');
        return {
          asOf: asOfStr,
          overall: emptyOverall,
          byStrategy: {},
          byTag: {},
          byRegime: {},
          recentClosedTrades: [],
          warnings,
        };
      }
      throw error;
    }

    const rows = (data ?? []) as TradePerformanceRow[];
    if (rows.length === 0) {
      warnings.push(`No closed trades in the last ${days} days.`);
      return {
        asOf: asOfStr,
        overall: emptyOverall,
        byStrategy: {},
        byTag: {},
        byRegime: {},
        recentClosedTrades: [],
        warnings,
      };
    }

    const overall = computeGroupMetrics(rows);
    const portfolioReturn = portfolioRealizedReturnPct(rows);
    const byStrategy = aggregateByGroup(rows, r => r.strategy);
    const byTag = aggregateByGroup(rows.filter(r => r.tag), r => r.tag!);
    const byRegime = aggregateByGroup(rows, regimeBucket);

    const MIN_TRADES = 10;
    for (const [k, m] of Object.entries(byStrategy)) {
      if (m.count_trades_closed < MIN_TRADES) warnings.push(`Insufficient sample size: ${k} has ${m.count_trades_closed} trades (<${MIN_TRADES})`);
    }
    for (const [k, m] of Object.entries(byTag)) {
      if (m.count_trades_closed < MIN_TRADES) warnings.push(`Insufficient sample size: ${k} has ${m.count_trades_closed} trades (<${MIN_TRADES})`);
    }

    return {
      asOf: asOfStr,
      overall: { ...overall, portfolio_realized_return_pct: portfolioReturn },
      byStrategy,
      byTag,
      byRegime,
      recentClosedTrades: rows.slice(0, 50),
      warnings,
    };
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : 'Failed to load performance data');
    return {
      asOf: asOfStr,
      overall: emptyOverall,
      byStrategy: {},
      byTag: {},
      byRegime: {},
      recentClosedTrades: [],
      warnings,
    };
  }
}
