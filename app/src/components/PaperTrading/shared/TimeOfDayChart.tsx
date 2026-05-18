import { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';

export interface TimeOfDayChartProps {
  data: Array<{ date: string; pnl: number }>;
}

const MARKET_HOURS = [9, 10, 11, 12, 13, 14, 15];

function formatHour(h: number): string {
  if (h === 0) return '12 AM';
  if (h < 12) return `${h} AM`;
  if (h === 12) return '12 PM';
  return `${h - 12} PM`;
}

export function TimeOfDayChart({ data }: TimeOfDayChartProps) {
  const chartData = useMemo(() => {
    const buckets = new Map<number, { total: number; count: number; wins: number }>();
    for (const h of MARKET_HOURS) {
      buckets.set(h, { total: 0, count: 0, wins: 0 });
    }

    for (const trade of data) {
      const etTime = new Date(trade.date).toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        hour12: false,
      });
      const hour = parseInt(etTime, 10);
      if (hour < 9 || hour > 15) continue;

      const bucket = buckets.get(hour);
      if (bucket) {
        bucket.total += trade.pnl;
        bucket.count++;
        if (trade.pnl > 0) bucket.wins++;
      }
    }

    return MARKET_HOURS.map(h => {
      const b = buckets.get(h)!;
      return {
        hour: formatHour(h),
        avgPnl: b.count > 0 ? b.total / b.count : 0,
        trades: b.count,
        winRate: b.count > 0 ? Math.round((b.wins / b.count) * 100) : 0,
      };
    });
  }, [data]);

  const hasData = chartData.some(d => d.trades > 0);

  if (!hasData) {
    return (
      <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-4">
        <h3 className="text-sm font-semibold text-[hsl(var(--foreground))] mb-3">Time-of-Day Performance</h3>
        <div className="h-[250px] flex items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
          No trade data to analyze
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-4">
      <h3 className="text-sm font-semibold text-[hsl(var(--foreground))] mb-1">Time-of-Day Performance</h3>
      <p className="text-[10px] text-[hsl(var(--muted-foreground))] mb-3">Average P&L by entry hour (ET)</p>

      <ResponsiveContainer width="100%" height={250}>
        <BarChart data={chartData} margin={{ top: 10, right: 10, bottom: 20, left: 10 }}>
          <XAxis
            dataKey="hour"
            tick={{ fontSize: 11 }}
            axisLine={{ stroke: 'hsl(var(--border))' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `$${v.toFixed(0)}`}
          />
          <Tooltip
            content={({ payload }) => {
              if (!payload || payload.length === 0) return null;
              const item = payload[0]?.payload as { hour: string; avgPnl: number; trades: number; winRate: number } | undefined;
              if (!item) return null;
              return (
                <div className="rounded-lg bg-gray-900 text-white px-3 py-2 text-xs shadow-lg">
                  <p className="font-medium">{item.hour}</p>
                  <p>Avg P&L: ${item.avgPnl.toFixed(2)}</p>
                  <p>Trades: {item.trades}</p>
                  <p>Win Rate: {item.winRate}%</p>
                </div>
              );
            }}
          />
          <Bar dataKey="avgPnl" radius={[4, 4, 0, 0]}>
            {chartData.map((entry, idx) => (
              <Cell
                key={idx}
                fill={entry.avgPnl >= 0 ? '#10b981' : '#ef4444'}
                opacity={entry.trades === 0 ? 0.2 : 0.85}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
