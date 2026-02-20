/**
 * API client for paper trading performance (consumes auto-trader service).
 */

const API_BASE = 'http://localhost:3001/api';

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
  const res = await fetch(`${API_BASE}/paper-trading/performance?window=${window}`);
  if (!res.ok) {
    throw new Error(`Performance API error: ${res.status}`);
  }
  return res.json();
}
