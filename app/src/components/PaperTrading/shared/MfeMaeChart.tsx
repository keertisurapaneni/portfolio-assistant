import { useState, useEffect } from 'react';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { getMfeMaeData, type AccountView } from '../../../lib/paperTradesApi';

type View = 'mfe' | 'mae';

interface MfeMaePoint {
  ticker: string;
  maxRunup: number;
  maxDrawdown: number;
  realizedReturn: number;
  strategy: string;
}

export interface MfeMaeChartProps {
  accountView?: AccountView;
}

export function MfeMaeChart({ accountView = 'paper' }: MfeMaeChartProps) {
  const [view, setView] = useState<View>('mfe');
  const [data, setData] = useState<MfeMaePoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getMfeMaeData(accountView).then(result => {
      if (!cancelled) {
        setData(result);
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [accountView]);

  if (loading) {
    return (
      <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-4">
        <h3 className="text-sm font-semibold text-[hsl(var(--foreground))] mb-3">MFE / MAE Analysis</h3>
        <div className="h-[300px] flex items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
          Loading...
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-4">
        <h3 className="text-sm font-semibold text-[hsl(var(--foreground))] mb-3">MFE / MAE Analysis</h3>
        <div className="h-[300px] flex items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
          No MFE/MAE data yet
        </div>
      </div>
    );
  }

  const winners = data.filter(d => d.realizedReturn > 0);
  const losers = data.filter(d => d.realizedReturn <= 0);

  const chartData = (subset: MfeMaePoint[]) =>
    subset.map(d => ({
      x: view === 'mfe' ? d.maxRunup : d.maxDrawdown,
      y: d.realizedReturn,
      ticker: d.ticker,
      strategy: d.strategy,
    }));

  const xLabel = view === 'mfe' ? 'Max Favorable Excursion (%)' : 'Max Adverse Excursion (%)';
  const insight = view === 'mfe'
    ? 'Points below the 45° line = left money on the table'
    : 'Wide x-values with losses = stops may be too wide';

  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">MFE / MAE Analysis</h3>
        <div className="flex rounded-lg border border-[hsl(var(--border))] overflow-hidden">
          <button
            onClick={() => setView('mfe')}
            className={`px-3 py-1 text-xs font-medium transition-colors ${
              view === 'mfe'
                ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
                : 'hover:bg-[hsl(var(--secondary))]'
            }`}
          >
            MFE
          </button>
          <button
            onClick={() => setView('mae')}
            className={`px-3 py-1 text-xs font-medium transition-colors ${
              view === 'mae'
                ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
                : 'hover:bg-[hsl(var(--secondary))]'
            }`}
          >
            MAE
          </button>
        </div>
      </div>

      <p className="text-[10px] text-[hsl(var(--muted-foreground))] mb-2">{insight}</p>

      <ResponsiveContainer width="100%" height={300}>
        <ScatterChart margin={{ top: 10, right: 20, bottom: 30, left: 10 }}>
          <XAxis
            type="number"
            dataKey="x"
            name={xLabel}
            unit="%"
            tick={{ fontSize: 11 }}
            label={{ value: xLabel, position: 'bottom', offset: 15, fontSize: 11 }}
          />
          <YAxis
            type="number"
            dataKey="y"
            name="Realized Return"
            unit="%"
            tick={{ fontSize: 11 }}
            label={{ value: 'Realized Return (%)', angle: -90, position: 'insideLeft', offset: 5, fontSize: 11 }}
          />
          <Tooltip
            content={({ payload }) => {
              if (!payload || payload.length === 0) return null;
              const point = payload[0]?.payload as { ticker: string; x: number; y: number; strategy: string } | undefined;
              if (!point) return null;
              return (
                <div className="rounded-lg bg-gray-900 text-white px-3 py-2 text-xs shadow-lg">
                  <p className="font-medium">{point.ticker}</p>
                  <p>{view === 'mfe' ? 'MFE' : 'MAE'}: {point.x.toFixed(2)}%</p>
                  <p>Return: {point.y.toFixed(2)}%</p>
                  <p className="text-gray-400">{point.strategy}</p>
                </div>
              );
            }}
          />
          {view === 'mfe' && (
            <ReferenceLine
              segment={[{ x: 0, y: 0 }, { x: Math.max(...data.map(d => d.maxRunup), 10), y: Math.max(...data.map(d => d.maxRunup), 10) }]}
              stroke="#9ca3af"
              strokeDasharray="4 4"
              strokeWidth={1}
            />
          )}
          <ReferenceLine y={0} stroke="#d1d5db" strokeWidth={1} />
          <Scatter
            name="Winners"
            data={chartData(winners)}
            fill="#10b981"
            opacity={0.7}
          />
          <Scatter
            name="Losers"
            data={chartData(losers)}
            fill="#ef4444"
            opacity={0.7}
          />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
