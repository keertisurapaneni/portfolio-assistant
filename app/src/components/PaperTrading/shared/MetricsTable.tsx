import { cn } from '../../../lib/utils';
import type { GroupMetrics } from '../../../lib/paperTradingPerformanceApi';

export interface MetricsTableProps {
  data: Record<string, GroupMetrics>;
  rowLabel: (k: string) => string;
  colHeader?: string;
}

export function MetricsTable({
  data,
  rowLabel,
  colHeader = 'Strategy',
}: MetricsTableProps) {
  const entries = Object.entries(data);
  if (entries.length === 0) return null;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="bg-[hsl(var(--secondary))]/50 text-[hsl(var(--muted-foreground))] text-xs">
          <th className="text-left px-4 py-2.5 font-medium">{colHeader}</th>
          <th className="text-right px-4 py-2.5 font-medium">Trades</th>
          <th className="text-right px-4 py-2.5 font-medium">Win%</th>
          <th className="text-right px-4 py-2.5 font-medium">Avg Return%</th>
          <th className="text-right px-4 py-2.5 font-medium">Profit Factor</th>
          <th className="text-right px-4 py-2.5 font-medium">Avg Hold</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[hsl(var(--border))]">
        {entries.map(([k, m]) => (
          <tr key={k} className="hover:bg-[hsl(var(--secondary))]/50">
            <td className="px-4 py-2.5 font-medium">{rowLabel(k)}</td>
            <td className="px-4 py-2.5 text-right tabular-nums">{m.count_trades_closed}</td>
            <td className={cn('px-4 py-2.5 text-right tabular-nums', m.win_rate >= 0.5 ? 'text-emerald-600' : 'text-red-600')}>
              {(m.win_rate * 100).toFixed(1)}%
            </td>
            <td className={cn('px-4 py-2.5 text-right tabular-nums', m.avg_return_pct >= 0 ? 'text-emerald-600' : 'text-red-600')}>
              {m.avg_return_pct.toFixed(2)}%
            </td>
            <td className="px-4 py-2.5 text-right tabular-nums">{m.profit_factor}</td>
            <td className="px-4 py-2.5 text-right tabular-nums">{m.avg_days_held.toFixed(1)}d</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
