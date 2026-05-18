import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

interface DrawdownChartProps {
  data: Array<{ date: string; pnl: number }>;
}

export function DrawdownChart({ data }: DrawdownChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[200px] text-sm text-[hsl(var(--muted-foreground))]">
        No data for drawdown
      </div>
    );
  }

  let cumPnl = 0;
  let peak = 0;
  const chartData = data.map(item => {
    cumPnl += item.pnl;
    if (cumPnl > peak) peak = cumPnl;
    const drawdownPct = peak > 0 ? ((cumPnl - peak) / peak) * 100 : 0;
    return { date: item.date, drawdown: Math.min(0, drawdownPct) };
  });

  const formatDate = (val: string) => {
    const d = new Date(val);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
        <XAxis
          dataKey="date"
          tickFormatter={formatDate}
          tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
          tickLine={false}
          axisLine={false}
          minTickGap={40}
        />
        <YAxis
          tickFormatter={(val: number) => `${val.toFixed(0)}%`}
          tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
          tickLine={false}
          axisLine={false}
          width={50}
          domain={['dataMin', 0]}
        />
        <Tooltip
          formatter={(value) => [`${Number(value).toFixed(2)}%`, 'Drawdown']}
          labelFormatter={(label) => formatDate(String(label))}
          contentStyle={{
            borderRadius: '8px',
            border: '1px solid hsl(var(--border))',
            fontSize: '12px',
          }}
        />
        <Area
          type="monotone"
          dataKey="drawdown"
          stroke="#ef4444"
          fill="#ef4444"
          fillOpacity={0.15}
          strokeWidth={1.5}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
