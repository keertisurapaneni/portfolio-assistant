import { useState, useRef, useEffect } from 'react';
import { Activity, Loader2, RefreshCw } from 'lucide-react';
import { createChart, CandlestickSeries, LineSeries, ColorType } from 'lightweight-charts';
import { cn } from '../lib/utils';
import { SignalBadge } from './SignalBadge';
import { StatCard } from './StatCard';
import { ErrorBanner } from './ErrorBanner';
import {
  fetchTradingSignal,
  getStoredMode,
  setStoredMode,
  type TradingSignalsResponse,
  type SignalsMode,
  type ChartCandle,
} from '../lib/tradingSignalsApi';

function formatPrice(n: number | null): string {
  if (n == null) return '—';
  return n.toFixed(2);
}

function ChartPanel({ candles, overlays }: { candles: ChartCandle[]; overlays: { label: string; price: number }[] }) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<ReturnType<typeof createChart> | null>(null);

  useEffect(() => {
    if (!chartRef.current || candles.length === 0) return;

    const chart = createChart(chartRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#64748b' },
      grid: { vertLines: { color: '#f1f5f9' }, horzLines: { color: '#f1f5f9' } },
      width: chartRef.current.clientWidth,
      height: 360,
      timeScale: { borderColor: '#e2e8f0', timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: '#e2e8f0' },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });

    // For intraday candles (day trade), timestamps contain time info (length > 10).
    // Lightweight Charts needs unique ascending times:
    //   - Daily+ data: use 'YYYY-MM-DD' string
    //   - Intraday data: use Unix timestamp (seconds)
    const isIntraday = candles.some((c) => c.t.length > 10);

    const seriesData = [...candles]
      .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
      .map((c) => ({
        time: isIntraday
          ? (Math.floor(new Date(c.t).getTime() / 1000) as unknown as string)
          : c.t.slice(0, 10),
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
      }));
    candleSeries.setData(seriesData);

    overlays.forEach((o) => {
      const lineColor = o.label === 'Entry' ? '#4da6ff' : o.label === 'Stop' ? '#ef5350' : '#26a69a';
      const line = chart.addSeries(LineSeries, { color: lineColor, lineWidth: 1, title: o.label, lineStyle: 2 });
      line.setData(seriesData.map((d) => ({ time: d.time, value: o.price })));
    });

    chart.timeScale().fitContent();
    chartInstance.current = chart;

    const onResize = () => chart.applyOptions({ width: chartRef.current?.clientWidth ?? 0 });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.remove();
      chartInstance.current = null;
    };
  }, [candles, overlays]);

  return <div ref={chartRef} className="w-full rounded-xl border border-[hsl(var(--border))] bg-white shadow-sm" />;
}

export function TradingSignals() {
  const [ticker, setTicker] = useState('');
  const [mode, setMode] = useState<SignalsMode>(() => getStoredMode());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TradingSignalsResponse | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // Live timer while loading
  useEffect(() => {
    if (!loading) { setElapsed(0); return; }
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [loading]);

  const handleModeChange = (m: SignalsMode) => {
    setMode(m);
    setStoredMode(m);
    setResult(null);
    setError(null);
  };

  const fetchSignal = async (sym: string) => {
    setError(null);
    setLoading(true);
    setResult(null);
    try {
      const data = await fetchTradingSignal(sym, mode);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch signal');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const sym = ticker.trim().toUpperCase();
    if (!sym) {
      setError('Enter a ticker symbol');
      return;
    }
    fetchSignal(sym);
  };

  const handleRefresh = () => {
    const sym = ticker.trim().toUpperCase();
    if (sym) fetchSignal(sym);
  };

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold text-[hsl(var(--foreground))]">Trade Signals</h1>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 text-xs font-medium">
            <Activity className="w-3 h-3" />
            Live
          </span>
        </div>
        <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
          Get a single actionable signal (Day or Swing) with entry, stop, target, and confidence.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-4">
        <div className="flex-1 min-w-[140px]">
          <label htmlFor="ticker" className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1">
            Ticker
          </label>
          <input
            id="ticker"
            type="text"
            placeholder="e.g. AAPL"
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            className="w-full rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-4 py-2.5 text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
            disabled={loading}
          />
        </div>
        <div>
          <span className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1">Mode</span>
          <div className="flex rounded-lg bg-[hsl(var(--secondary))] p-0.5 gap-0.5">
            <button
              type="button"
              onClick={() => handleModeChange('SWING_TRADE')}
              className={cn(
                'px-4 py-2 text-sm font-medium rounded-md transition-all',
                mode === 'SWING_TRADE'
                  ? 'bg-white text-[hsl(var(--foreground))] shadow-sm'
                  : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
              )}
            >
              Swing
            </button>
            <button
              type="button"
              onClick={() => handleModeChange('DAY_TRADE')}
              className={cn(
                'px-4 py-2 text-sm font-medium rounded-md transition-all',
                mode === 'DAY_TRADE'
                  ? 'bg-white text-[hsl(var(--foreground))] shadow-sm'
                  : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
              )}
            >
              Day
            </button>
          </div>
        </div>
        <button
          type="submit"
          disabled={loading}
          className="flex items-center gap-2 rounded-lg bg-[hsl(var(--primary))] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[hsl(221,83%,48%)] hover:shadow-lg hover:shadow-blue-500/25 disabled:opacity-60 transition-all"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Getting signal… <span className="tabular-nums text-white/70">{elapsed}s</span>
            </>
          ) : (
            <>
              <Activity className="h-4 w-4" /> Get signal
            </>
          )}
        </button>
      </form>

      {error && <ErrorBanner message={error} />}

      {result && (
        <div className="space-y-6 animate-fade-in-up">
          <div className={cn(
            'rounded-xl border bg-white p-6 shadow-md',
            result.trade.recommendation === 'BUY' && 'border-emerald-200',
            result.trade.recommendation === 'SELL' && 'border-red-200',
            result.trade.recommendation === 'HOLD' && 'border-amber-200',
          )}>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <SignalBadge signal={result.trade.recommendation} size="lg" pulse />
                <span className="text-sm text-[hsl(var(--muted-foreground))]">
                  {result.trade.mode.replace('_', ' ')} · {result.trade.confidence} confidence
                </span>
              </div>
              <button
                type="button"
                onClick={handleRefresh}
                disabled={loading}
                className="flex items-center gap-1.5 rounded-lg border border-[hsl(var(--input))] px-3 py-1.5 text-xs font-medium text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))] disabled:opacity-60 transition-colors"
                title="Refresh signal"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Refresh
              </button>
            </div>
            {result.trade.recommendation === 'HOLD' ? (
              <div className="mt-4 rounded-lg bg-[hsl(var(--secondary))] px-4 py-3 text-sm text-[hsl(var(--muted-foreground))]">
                No trade recommended right now — conditions don't meet the criteria. Check back later or try a different mode.
              </div>
            ) : (
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard label="Entry" value={formatPrice(result.trade.entryPrice)} color="blue" />
                <StatCard label="Stop" value={formatPrice(result.trade.stopLoss)} color="red" />
                <StatCard label="Target" value={formatPrice(result.trade.targetPrice)} color="green" />
                <StatCard label="R:R" value={result.trade.riskReward ?? '—'} color="purple" />
              </div>
            )}
            {result.trade.rationale && (result.trade.rationale.technical || result.trade.rationale.sentiment || result.trade.rationale.risk) && (
              <div className="mt-4 space-y-2.5 border-t border-[hsl(var(--border))] pt-4">
                {result.trade.rationale.technical && (
                  <div className="flex items-start gap-2 text-sm">
                    <span className="shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full bg-blue-500" />
                    <p><span className="font-semibold text-[hsl(var(--foreground))]">Technical:</span> <span className="text-[hsl(var(--muted-foreground))]">{result.trade.rationale.technical}</span></p>
                  </div>
                )}
                {result.trade.rationale.sentiment && (
                  <div className="flex items-start gap-2 text-sm">
                    <span className="shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full bg-purple-500" />
                    <p><span className="font-semibold text-[hsl(var(--foreground))]">Sentiment:</span> <span className="text-[hsl(var(--muted-foreground))]">{result.trade.rationale.sentiment}</span></p>
                  </div>
                )}
                {result.trade.rationale.risk && (
                  <div className="flex items-start gap-2 text-sm">
                    <span className="shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full bg-amber-500" />
                    <p><span className="font-semibold text-[hsl(var(--foreground))]">Risk:</span> <span className="text-[hsl(var(--muted-foreground))]">{result.trade.rationale.risk}</span></p>
                  </div>
                )}
              </div>
            )}
          </div>

          {result.chart.candles.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-[hsl(var(--foreground))]">
                Chart ({result.chart.timeframe})
              </h3>
              <ChartPanel
                candles={result.chart.candles}
                overlays={result.chart.overlays.map((o) => ({ label: o.label, price: o.price }))}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
