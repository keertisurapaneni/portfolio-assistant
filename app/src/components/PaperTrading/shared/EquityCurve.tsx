import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  CartesianGrid,
} from 'recharts';

interface EquityCurveProps {
  data: Array<{ date: string; pnl: number }>;
}

export function EquityCurve({ data }: EquityCurveProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[300px] text-sm text-[hsl(var(--muted-foreground))]">
        No closed trades to display
      </div>
    );
  }

  const chartData = data.reduce<Array<{ date: string; cumPnl: number }>>((acc, item) => {
    const prev = acc.length > 0 ? acc[acc.length - 1]!.cumPnl : 0;
    acc.push({ date: item.date, cumPnl: prev + item.pnl });
    return acc;
  }, []);

  const formatDate = (val: string) => {
    const d = new Date(val);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  const formatDollar = (val: number) =>
    `${val < 0 ? '-' : ''}$${Math.abs(val).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  const allPositive = chartData.every(d => d.cumPnl >= 0);
  const allNegative = chartData.every(d => d.cumPnl <= 0);

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="date"
          tickFormatter={formatDate}
          tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
          tickLine={false}
          axisLine={false}
          minTickGap={40}
        />
        <YAxis
          tickFormatter={formatDollar}
          tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
          tickLine={false}
          axisLine={false}
          width={70}
        />
        <Tooltip
          formatter={(value) => [formatDollar(Number(value)), 'Cumulative P&L']}
          labelFormatter={(label) => formatDate(String(label))}
          contentStyle={{
            borderRadius: '8px',
            border: '1px solid hsl(var(--border))',
            fontSize: '12px',
          }}
        />
        <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" strokeOpacity={0.5} />
        {allPositive && (
          <Line
            type="monotone"
            dataKey="cumPnl"
            stroke="#10b981"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        )}
        {allNegative && (
          <Line
            type="monotone"
            dataKey="cumPnl"
            stroke="#ef4444"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        )}
        {!allPositive && !allNegative && (
          <>
            <defs>
              <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#10b981" />
                <stop offset="50%" stopColor="#10b981" />
                <stop offset="50%" stopColor="#ef4444" />
                <stop offset="100%" stopColor="#ef4444" />
              </linearGradient>
            </defs>
            <Line
              type="monotone"
              dataKey="cumPnl"
              stroke="#10b981"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </>
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}
