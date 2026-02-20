/**
 * API client for paper trading performance.
 * Uses Supabase Edge Function so it works on deployed website (no localhost).
 */

const PERFORMANCE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/paper-trading-performance`;

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

export interface RecentClosedTrade {
  trade_id: string;
  ticker: string;
  strategy: string;
  tag: string | null;
  exit_datetime: string;
  realized_return_pct: number | null;
  close_reason: string | null;
  [key: string]: unknown;
}

export interface PerformanceResponse {
  asOf: string;
  overall: GroupMetrics & { portfolio_realized_return_pct: number };
  byStrategy: Record<string, GroupMetrics>;
  byTag: Record<string, GroupMetrics>;
  byRegime: Record<string, GroupMetrics>;
  recentClosedTrades: RecentClosedTrade[];
  warnings: string[];
}

export async function getPaperTradingPerformance(
  window: '7d' | '30d' | '90d' = '30d'
): Promise<PerformanceResponse> {
  const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const res = await fetch(`${PERFORMANCE_URL}?window=${window}`, {
    headers: { Authorization: `Bearer ${supabaseKey}` },
  });
  if (!res.ok) {
    throw new Error(`Performance API error: ${res.status}`);
  }
  return res.json();
}
