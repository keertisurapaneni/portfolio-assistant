/**
 * Weekly report generator from trade_performance_log.
 * No scheduling — call on demand.
 */

import { getSupabase } from './supabase.js';
import { getPerformanceSummary } from './tradePerformanceMetrics.js';
import type { GroupMetrics } from './tradePerformanceMetrics.js';

export interface WeeklyReport {
  asOf: string;
  last7d: {
    byStrategy: Record<string, number>;
    byTag: Record<string, number>;
    total: number;
  };
  last30d: {
    byStrategy: Record<string, GroupMetrics>;
    byTag: Record<string, GroupMetrics>;
  };
  best3Tickers: Array<{ ticker: string; realized_return_pct: number; strategy: string }>;
  worst3Tickers: Array<{ ticker: string; realized_return_pct: number; strategy: string }>;
  dataSufficiencyWarnings: string[];
}

/** Generate weekly report. */
export async function generateWeeklyReport(options?: { asOf?: Date }): Promise<WeeklyReport> {
  const asOf = options?.asOf ?? new Date();
  const asOfStr = asOf.toISOString();
  const d7 = new Date(asOf);
  d7.setDate(d7.getDate() - 7);
  const d30 = new Date(asOf);
  d30.setDate(d30.getDate() - 30);

  const sb = getSupabase();
  const { data, error } = await sb
    .from('trade_performance_log')
    .select('*')
    .gte('exit_datetime', d30.toISOString())
    .lte('exit_datetime', asOfStr);

  if (error) throw new Error(`generateWeeklyReport: ${error.message}`);
  const trades = (data ?? []) as Array<{
    ticker: string;
    strategy: string;
    tag: string | null;
    exit_datetime: string;
    realized_return_pct: number | null;
  }>;

  const rows7 = trades.filter(r => new Date(r.exit_datetime) >= d7);
  const rows30 = trades;

  const byStrategy7 = new Map<string, number>();
  const byTag7 = new Map<string, number>();
  for (const r of rows7) {
    byStrategy7.set(r.strategy, (byStrategy7.get(r.strategy) ?? 0) + 1);
    if (r.tag) byTag7.set(r.tag, (byTag7.get(r.tag) ?? 0) + 1);
  }

  const summary = await getPerformanceSummary({ asOf });

  const withReturn = rows30.filter(r => r.realized_return_pct != null);
  const sorted = [...withReturn].sort((a, b) => (b.realized_return_pct ?? 0) - (a.realized_return_pct ?? 0));
  const best3 = sorted.slice(0, 3).map(r => ({
    ticker: r.ticker,
    realized_return_pct: r.realized_return_pct!,
    strategy: r.strategy,
  }));
  const worst3 = sorted.slice(-3).reverse().map(r => ({
    ticker: r.ticker,
    realized_return_pct: r.realized_return_pct!,
    strategy: r.strategy,
  }));

  const warnings: string[] = [];
  const MIN_TRADES = 10;
  for (const [strategy, m] of Object.entries(summary.rolling30d.byStrategy)) {
    if (m.count_trades_closed < MIN_TRADES) {
      warnings.push(`<10 closed trades in ${strategy} (30d) → do not tune thresholds`);
    }
  }
  for (const [tag, m] of Object.entries(summary.rolling30d.byTag)) {
    if (m.count_trades_closed < MIN_TRADES) {
      warnings.push(`<10 closed trades in ${tag} (30d) → do not tune thresholds`);
    }
  }

  return {
    asOf: asOfStr,
    last7d: {
      byStrategy: Object.fromEntries(byStrategy7),
      byTag: Object.fromEntries(byTag7),
      total: rows7.length,
    },
    last30d: {
      byStrategy: summary.rolling30d.byStrategy,
      byTag: summary.rolling30d.byTag,
    },
    best3Tickers: best3,
    worst3Tickers: worst3,
    dataSufficiencyWarnings: warnings,
  };
}
