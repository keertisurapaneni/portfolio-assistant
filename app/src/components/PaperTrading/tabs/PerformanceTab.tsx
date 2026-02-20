import { useState, useEffect, useCallback } from 'react';
import {
  BarChart2,
  RefreshCw,
  AlertTriangle,
  XCircle,
  X,
  TrendingUp,
  TrendingDown,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { CategoryPerformance } from '../../../lib/paperTradesApi';
import {
  getPaperTradingPerformance,
  type PerformanceResponse,
  type RecentClosedTrade,
} from '../../../lib/paperTradingPerformanceApi';
import { fmtUsd } from '../utils';
import { SignalScorecard } from '../shared';
import { MetricsTable } from '../shared/MetricsTable';
import { formatRegimeLabel } from '../utils';
import { Spinner } from '../../Spinner';

export interface PerformanceTabProps {
  categories: CategoryPerformance[];
  totalDeployed: number;
  maxAllocation: number;
}

export function PerformanceTab({
  categories,
  totalDeployed,
  maxAllocation,
}: PerformanceTabProps) {
  const [window, setWindow] = useState<'7d' | '30d' | '90d'>('30d');
  const [data, setData] = useState<PerformanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTrade, setSelectedTrade] = useState<RecentClosedTrade | null>(null);

  const sf = categories.find(c => c.category === 'suggested_finds');
  const dt = categories.find(c => c.category === 'day_trade');
  const sw = categories.find(c => c.category === 'swing_trade');
  const dipBuy = categories.find(c => c.category === 'dip_buy');
  const profitTake = categories.find(c => c.category === 'profit_take');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getPaperTradingPerformance(window);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load performance');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [window]);

  useEffect(() => { load(); }, [load]);

  const hasInsufficientWarnings = data?.warnings.some(w =>
    w.toLowerCase().includes('insufficient') || w.toLowerCase().includes('<10')
  ) ?? false;

  if (loading && !data) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-[hsl(var(--foreground))]">Capital Deployed</span>
            <span className="text-xs font-bold tabular-nums">
              ${totalDeployed.toLocaleString(undefined, { maximumFractionDigits: 0 })} / ${maxAllocation.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
          </div>
          <div className="w-full h-2.5 rounded-full bg-slate-100 overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                maxAllocation > 0 && totalDeployed / maxAllocation < 0.6 ? 'bg-emerald-500' :
                maxAllocation > 0 && totalDeployed / maxAllocation < 0.85 ? 'bg-amber-500' : 'bg-red-500'
              )}
              style={{ width: `${Math.min(100, maxAllocation > 0 ? (totalDeployed / maxAllocation) * 100 : 0)}%` }}
            />
          </div>
          <p className="text-[10px] text-[hsl(var(--muted-foreground))] mt-1">
            {maxAllocation > 0 ? ((totalDeployed / maxAllocation) * 100).toFixed(1) : 0}% of testing budget allocated
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <SignalScorecard title="Suggested Finds" subtitle="Long-term picks" data={sf} color="indigo" />
          <SignalScorecard title="Day Trades" subtitle="Scanner signals" data={dt} color="blue" />
          <SignalScorecard title="Swing Trades" subtitle="Scanner signals" data={sw} color="violet" />
        </div>

        {((dipBuy?.totalTrades ?? 0) > 0 || (profitTake?.totalTrades ?? 0) > 0) && (
          <div className="flex gap-3 text-xs">
            {(dipBuy?.totalTrades ?? 0) > 0 && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-50 border border-blue-100">
                <TrendingDown className="w-3 h-3 text-blue-600" />
                <span className="text-blue-700 font-medium">Dip Buys: {dipBuy!.totalTrades}</span>
                {dipBuy!.totalPnl !== 0 && (
                  <span className={cn('font-bold', dipBuy!.totalPnl > 0 ? 'text-emerald-600' : 'text-red-600')}>
                    {fmtUsd(dipBuy!.totalPnl, 0, true)}
                  </span>
                )}
              </div>
            )}
            {(profitTake?.totalTrades ?? 0) > 0 && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-100">
                <TrendingUp className="w-3 h-3 text-emerald-600" />
                <span className="text-emerald-700 font-medium">Profit Takes: {profitTake!.totalTrades}</span>
                {profitTake!.totalPnl !== 0 && (
                  <span className={cn('font-bold', profitTake!.totalPnl > 0 ? 'text-emerald-600' : 'text-red-600')}>
                    {fmtUsd(profitTake!.totalPnl, 0, true)}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="pt-2 border-t border-[hsl(var(--border))]">
        <h3 className="text-sm font-semibold text-[hsl(var(--foreground))] mb-3">Attribution (rolling window)</h3>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-[hsl(var(--muted-foreground))]">Window:</span>
        {(['7d', '30d', '90d'] as const).map(w => (
          <button
            key={w}
            onClick={() => setWindow(w)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
              window === w
                ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
                : 'bg-[hsl(var(--secondary))] hover:bg-[hsl(var(--secondary))]/80'
            )}
          >
            {w}
          </button>
        ))}
        <button onClick={load} className="ml-2 p-1.5 rounded-lg hover:bg-[hsl(var(--secondary))]" title="Refresh">
          <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
        </button>
      </div>

      {data?.warnings && data.warnings.length > 0 && (
        <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200">
          <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            {hasInsufficientWarnings && (
              <p className="text-sm font-medium text-amber-800">Insufficient sample size — do not tune thresholds yet.</p>
            )}
            <ul className="text-xs text-amber-700 mt-1 space-y-0.5">
              {data.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-red-50 border border-red-200">
          <XCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
          <p className="text-sm text-red-800">{error}</p>
          <p className="text-xs text-red-600">Check your connection and Supabase configuration.</p>
        </div>
      )}

      {!data && !loading && (
        <div className="text-center py-12">
          <BarChart2 className="w-10 h-10 text-[hsl(var(--muted-foreground))] opacity-40 mx-auto" />
          <p className="mt-3 text-sm text-[hsl(var(--muted-foreground))]">No performance data available</p>
          <p className="text-xs text-[hsl(var(--muted-foreground))] opacity-70 mt-1">Ensure auto-trader is running and migrations are applied</p>
        </div>
      )}

      {data && data.overall.count_trades_closed === 0 && !error && (
        <div className="text-center py-12">
          <BarChart2 className="w-10 h-10 text-[hsl(var(--muted-foreground))] opacity-40 mx-auto" />
          <p className="mt-3 text-sm text-[hsl(var(--muted-foreground))]">No closed trades in this window</p>
          <p className="text-xs text-[hsl(var(--muted-foreground))] opacity-70 mt-1">Close some trades to see attribution metrics</p>
        </div>
      )}

      {data && data.overall.count_trades_closed > 0 && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-4">
              <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">Realized Return %</p>
              <p className={cn('text-xl font-bold tabular-nums mt-0.5', data.overall.portfolio_realized_return_pct >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                {data.overall.portfolio_realized_return_pct.toFixed(2)}%
              </p>
            </div>
            <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-4">
              <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">Win Rate</p>
              <p className="text-xl font-bold tabular-nums mt-0.5">{(data.overall.win_rate * 100).toFixed(1)}%</p>
            </div>
            <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-4">
              <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">Profit Factor</p>
              <p className="text-xl font-bold tabular-nums mt-0.5">{data.overall.profit_factor}</p>
            </div>
            <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-4">
              <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">Trades Closed</p>
              <p className="text-xl font-bold tabular-nums mt-0.5">{data.overall.count_trades_closed}</p>
            </div>
          </div>

          {Object.keys(data.byStrategy).length > 0 && (
            <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))]">
                <h3 className="text-sm font-semibold">Strategy Breakdown</h3>
              </div>
              <MetricsTable data={data.byStrategy} rowLabel={k => k.replace('_', ' ')} />
            </div>
          )}

          {Object.keys(data.byTag).length > 0 && (
            <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))]">
                <h3 className="text-sm font-semibold">Long-Term Tag Breakdown</h3>
              </div>
              <MetricsTable data={data.byTag} rowLabel={k => k} colHeader="Tag" />
            </div>
          )}

          {Object.keys(data.byRegime).length > 0 && (
            <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))]">
                <h3 className="text-sm font-semibold">Regime Breakdown</h3>
                <p className="text-[10px] text-[hsl(var(--muted-foreground))] mt-0.5">SPY vs 200-day + VIX bucket at entry</p>
              </div>
              <MetricsTable data={data.byRegime} rowLabel={formatRegimeLabel} colHeader="Regime" />
            </div>
          )}

          {data.recentClosedTrades.length > 0 && (
            <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))]">
                <h3 className="text-sm font-semibold">Recent Closed Trades</h3>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[hsl(var(--secondary))]/50 text-[hsl(var(--muted-foreground))] text-xs">
                    <th className="text-left px-4 py-2.5 font-medium">Date Closed</th>
                    <th className="text-left px-4 py-2.5 font-medium">Ticker</th>
                    <th className="text-left px-4 py-2.5 font-medium">Strategy</th>
                    <th className="text-left px-4 py-2.5 font-medium">Tag</th>
                    <th className="text-right px-4 py-2.5 font-medium">Return%</th>
                    <th className="text-left px-4 py-2.5 font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[hsl(var(--border))]">
                  {data.recentClosedTrades.map(t => (
                    <tr
                      key={t.trade_id}
                      className="hover:bg-[hsl(var(--secondary))]/50 cursor-pointer"
                      onClick={() => setSelectedTrade(t)}
                    >
                      <td className="px-4 py-2.5 text-xs">
                        {new Date(t.exit_datetime).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })}
                      </td>
                      <td className="px-4 py-2.5 font-medium">{t.ticker}</td>
                      <td className="px-4 py-2.5">{t.strategy.replace('_', ' ')}</td>
                      <td className="px-4 py-2.5">{t.tag ?? '—'}</td>
                      <td className={cn(
                        'px-4 py-2.5 text-right tabular-nums font-medium',
                        (t.realized_return_pct ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'
                      )}>
                        {t.realized_return_pct != null ? `${t.realized_return_pct.toFixed(2)}%` : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-xs">{t.close_reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {selectedTrade && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setSelectedTrade(null)}>
          <div
            className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto p-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Trade Details</h3>
              <button onClick={() => setSelectedTrade(null)} className="p-1 rounded hover:bg-slate-100">
                <X className="w-5 h-5" />
              </button>
            </div>
            <dl className="space-y-2 text-sm">
              {Object.entries(selectedTrade).map(([k, v]) => (
                v != null && v !== '' && (
                  <div key={k} className="flex justify-between gap-4">
                    <dt className="text-[hsl(var(--muted-foreground))]">{k.replace(/_/g, ' ')}</dt>
                    <dd className="font-medium truncate">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
                  </div>
                )
              ))}
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
