import { cn } from '../../../lib/utils';
import { fmtUsd } from '../utils';
import type { CategoryPerformance } from '../../../lib/paperTradesApi';

export interface SignalScorecardProps {
  title: string;
  subtitle: string;
  data: CategoryPerformance | undefined;
  color: 'indigo' | 'blue' | 'violet';
}

const colorClasses = {
  indigo: 'border-indigo-200 bg-indigo-50',
  blue: 'border-blue-200 bg-blue-50',
  violet: 'border-violet-200 bg-violet-50',
};

const textColors = {
  indigo: 'text-indigo-700',
  blue: 'text-blue-700',
  violet: 'text-violet-700',
};

export function SignalScorecard({ title, subtitle, data, color }: SignalScorecardProps) {
  if (!data || data.totalTrades === 0) {
    return (
      <div className={cn('rounded-xl border p-4', colorClasses[color])}>
        <p className={cn('text-sm font-semibold', textColors[color])}>{title}</p>
        <p className="text-[10px] text-[hsl(var(--muted-foreground))]">{subtitle}</p>
        <p className="text-xs text-[hsl(var(--muted-foreground))] mt-3 opacity-60">No trades yet</p>
      </div>
    );
  }

  return (
    <div className={cn('rounded-xl border p-4', colorClasses[color])}>
      <div className="flex items-center justify-between mb-1">
        <div>
          <p className={cn('text-sm font-semibold', textColors[color])}>{title}</p>
          <p className="text-[10px] text-[hsl(var(--muted-foreground))]">{subtitle}</p>
        </div>
        <div className="text-right">
          <p className={cn(
            'text-lg font-bold tabular-nums',
            data.totalPnl > 0 ? 'text-emerald-600' : data.totalPnl < 0 ? 'text-red-600' : textColors[color]
          )}>
            {fmtUsd(data.totalPnl, 0, true)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mt-3">
        <div>
          <p className="text-[10px] text-[hsl(var(--muted-foreground))]">Executed</p>
          <p className={cn('text-sm font-bold tabular-nums', textColors[color])}>
            {data.activeTrades + data.wins + data.losses}
          </p>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))] opacity-60">
            {data.activeTrades > 0 ? `${data.activeTrades} active` : `${data.wins + data.losses} closed`}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-[hsl(var(--muted-foreground))]">Win Rate</p>
          <p className={cn('text-sm font-bold tabular-nums', data.winRate >= 50 ? 'text-emerald-600' : 'text-red-600')}>
            {data.winRate.toFixed(0)}%
          </p>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))] opacity-60">
            {data.wins}W / {data.losses}L
          </p>
        </div>
        <div>
          <p className="text-[10px] text-[hsl(var(--muted-foreground))]">Avg P&L</p>
          <p className={cn('text-sm font-bold tabular-nums', data.avgPnl >= 0 ? 'text-emerald-600' : 'text-red-600')}>
            {fmtUsd(data.avgPnl, 0, true)}
          </p>
          <p className="text-[9px] text-[hsl(var(--muted-foreground))] opacity-60">
            {data.avgReturnPct >= 0 ? '+' : ''}{data.avgReturnPct.toFixed(1)}% avg
          </p>
        </div>
      </div>

      {(data.bestTrade || data.worstTrade) && (
        <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-[hsl(var(--border))]/30">
          {data.bestTrade && (
            <div>
              <p className="text-[10px] text-[hsl(var(--muted-foreground))]">Best</p>
              <p className="text-xs font-bold text-emerald-600 tabular-nums truncate">
                {data.bestTrade.ticker} {fmtUsd(data.bestTrade.pnl, 0, true)}
              </p>
            </div>
          )}
          {data.worstTrade && (
            <div>
              <p className="text-[10px] text-[hsl(var(--muted-foreground))]">Worst</p>
              <p className="text-xs font-bold text-red-600 tabular-nums truncate">
                {data.worstTrade.ticker} {fmtUsd(data.worstTrade.pnl, 0)}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
