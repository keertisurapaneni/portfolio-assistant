import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';

interface PnlDistributionProps {
  pnls: number[];
}

export function PnlDistribution({ pnls }: PnlDistributionProps) {
  if (pnls.length === 0) {
    return (
      <div className="flex items-center justify-center h-[250px] text-sm text-[hsl(var(--muted-foreground))]">
        No trade P&L data to display
      </div>
    );
  }

  const min = Math.min(...pnls);
  const max = Math.max(...pnls);
  const range = max - min;

  const bucketCount = Math.min(20, Math.max(5, Math.ceil(pnls.length / 3)));
  const bucketSize = range / bucketCount || 1;

  const buckets: Array<{ label: string; count: number; midpoint: number }> = [];
  for (let i = 0; i < bucketCount; i++) {
    const low = min + i * bucketSize;
    const high = low + bucketSize;
    const midpoint = (low + high) / 2;
    const count = pnls.filter(p => {
      if (i === bucketCount - 1) return p >= low && p <= high;
      return p >= low && p < high;
    }).length;
    const label = `$${Math.round(low)}`;
    buckets.push({ label, count, midpoint });
  }

  return (
    <ResponsiveContainer width="100%" height={250}>
      <BarChart data={buckets} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
        <XAxis
          dataKey="label"
          tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
        />
        <Tooltip
          formatter={(value) => [Number(value), 'Trades']}
          labelFormatter={(label) => `Bucket: ${String(label)}`}
          contentStyle={{
            borderRadius: '8px',
            border: '1px solid hsl(var(--border))',
            fontSize: '12px',
          }}
        />
        <Bar dataKey="count" radius={[3, 3, 0, 0]}>
          {buckets.map((bucket, idx) => (
            <Cell
              key={idx}
              fill={bucket.midpoint >= 0 ? '#10b981' : '#ef4444'}
              fillOpacity={0.85}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
