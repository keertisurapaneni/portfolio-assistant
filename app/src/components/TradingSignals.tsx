import { useState, useRef, useEffect } from 'react';
import {
  Activity,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  TrendingUp,
  TrendingDown,
  BarChart3,
  Zap,
  Globe,
} from 'lucide-react';
import { Spinner } from './Spinner';
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
  type IndicatorValues,
  type MarketSnapshot,
  type LongTermOutlook,
} from '../lib/tradingSignalsApi';
import { TradeIdeas } from './TradeIdeas';

function formatPrice(n: number | null): string {
  if (n == null) return '—';
  return n.toFixed(2);
}

// ── Confidence Ring ─────────────────────────────────────

function ConfidenceScore({ score }: { score: number | string }) {
  let safe: number;
  if (typeof score === 'number' && !isNaN(score)) {
    safe = score;
  } else if (typeof score === 'string') {
    // Handle legacy string values from old edge function
    const parsed = parseFloat(score);
    if (!isNaN(parsed)) {
      safe = parsed;
    } else {
      safe = score.toUpperCase() === 'HIGH' ? 8 : score.toUpperCase() === 'MEDIUM' ? 5 : score.toUpperCase() === 'LOW' ? 3 : 5;
    }
  } else {
    safe = 5;
  }
  const clamped = Math.max(0, Math.min(10, Math.round(safe)));
  const pct = clamped / 10;
  const radius = 18;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pct);

  let color: string;
  if (clamped >= 7) color = '#22c55e';       // green
  else if (clamped >= 4) color = '#f59e0b';  // amber
  else color = '#ef4444';                     // red

  return (
    <div className="flex items-center gap-2">
      <svg width="44" height="44" className="transform -rotate-90">
        <circle cx="22" cy="22" r={radius} stroke="#e5e7eb" strokeWidth="4" fill="none" />
        <circle
          cx="22" cy="22" r={radius}
          stroke={color}
          strokeWidth="4"
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-700"
        />
      </svg>
      <div className="absolute w-[44px] flex items-center justify-center">
        <span className="text-sm font-bold" style={{ color }}>{clamped}</span>
      </div>
    </div>
  );
}

// ── Market Snapshot Banner ──────────────────────────────

function MarketBanner({ snapshot }: { snapshot: MarketSnapshot }) {
  const volColor =
    snapshot.volatility === 'Low' ? 'text-green-600' :
    snapshot.volatility === 'Moderate' ? 'text-amber-600' :
    snapshot.volatility === 'High' ? 'text-orange-600' : 'text-red-600';

  const biasIcon = snapshot.bias === 'Bullish'
    ? <TrendingUp className="w-3.5 h-3.5 text-green-600" />
    : <TrendingDown className="w-3.5 h-3.5 text-red-600" />;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--secondary))] px-4 py-2 text-xs text-[hsl(var(--muted-foreground))]">
      <span className="flex items-center gap-1.5">
        <Globe className="w-3.5 h-3.5" />
        Market
      </span>
      <span className="flex items-center gap-1">
        {biasIcon}
        SPY: <span className="font-medium text-[hsl(var(--foreground))]">{snapshot.spyTrend}</span>
      </span>
      <span>
        VIX: <span className={cn('font-medium', volColor)}>{snapshot.vix} ({snapshot.volatility})</span>
      </span>
    </div>
  );
}

// ── Scenario Card ───────────────────────────────────────

function ScenarioCard({
  label,
  probability,
  summary,
  color,
}: {
  label: string;
  probability: number;
  summary: string;
  color: 'green' | 'gray' | 'red';
}) {
  const barColor = { green: 'bg-green-500', gray: 'bg-gray-400', red: 'bg-red-500' }[color];
  const bgColor = { green: 'bg-green-50 border-green-100', gray: 'bg-gray-50 border-gray-100', red: 'bg-red-50 border-red-100' }[color];
  const labelColor = { green: 'text-green-700', gray: 'text-gray-600', red: 'text-red-700' }[color];

  return (
    <div className={cn('rounded-lg border p-3', bgColor)}>
      <div className="flex items-center justify-between mb-1.5">
        <span className={cn('text-xs font-semibold', labelColor)}>{label}</span>
        <span className={cn('text-xs font-bold tabular-nums', labelColor)}>{probability}%</span>
      </div>
      <div className="w-full h-1.5 rounded-full bg-white/70 mb-2">
        <div className={cn('h-full rounded-full transition-all duration-500', barColor)} style={{ width: `${probability}%` }} />
      </div>
      {summary && <p className="text-[11px] text-[hsl(var(--muted-foreground))] leading-snug">{summary}</p>}
    </div>
  );
}

// ── Collapsible Section ─────────────────────────────────

function CollapsibleSection({
  title,
  icon,
  defaultOpen = false,
  accentColor,
  preview,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  accentColor?: 'blue' | 'amber' | 'green' | 'purple';
  preview?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  const accentStyles: Record<string, { border: string; header: string; strip: string }> = {
    blue: { border: 'border-blue-200', header: 'bg-blue-50/60 hover:bg-blue-50', strip: 'bg-blue-500' },
    amber: { border: 'border-amber-200', header: 'bg-amber-50/60 hover:bg-amber-50', strip: 'bg-amber-500' },
    green: { border: 'border-green-200', header: 'bg-green-50/60 hover:bg-green-50', strip: 'bg-green-500' },
    purple: { border: 'border-purple-200', header: 'bg-purple-50/60 hover:bg-purple-50', strip: 'bg-purple-500' },
  };
  const accent = accentColor ? accentStyles[accentColor] : null;

  return (
    <div className={cn('rounded-xl overflow-hidden border', accent ? accent.border : 'border-[hsl(var(--border))]')}>
      {accent && <div className={cn('h-1', accent.strip)} />}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          'w-full flex flex-col px-4 py-3 text-left transition-colors',
          accent ? accent.header : 'hover:bg-[hsl(var(--accent))]'
        )}
      >
        <span className="flex items-center justify-between w-full">
          <span className="flex items-center gap-2 text-sm font-semibold text-[hsl(var(--foreground))]">
            {icon}
            {title}
          </span>
          {open ? <ChevronUp className="w-4 h-4 text-[hsl(var(--muted-foreground))]" /> : <ChevronDown className="w-4 h-4 text-[hsl(var(--muted-foreground))]" />}
        </span>
        {/* Inline preview — visible when collapsed */}
        {!open && preview && <div className="mt-2 w-full">{preview}</div>}
      </button>
      {open && <div className="px-4 pb-4 pt-1 bg-white">{children}</div>}
    </div>
  );
}

// ── Indicators Panel ────────────────────────────────────

function IndicatorsPanel({ indicators }: { indicators: IndicatorValues }) {
  const row = (label: string, value: string | null, interpretation?: string) => (
    <div className="flex items-center justify-between py-1.5 border-b border-[hsl(var(--border))] last:border-0">
      <span className="text-xs text-[hsl(var(--muted-foreground))]">{label}</span>
      <div className="text-right">
        <span className="text-xs font-semibold text-[hsl(var(--foreground))] tabular-nums">{value ?? '—'}</span>
        {interpretation && <span className="ml-1.5 text-[10px] text-[hsl(var(--muted-foreground))]">{interpretation}</span>}
      </div>
    </div>
  );

  const rsiInterp = indicators.rsi !== null
    ? indicators.rsi > 70 ? '(overbought)' : indicators.rsi < 30 ? '(oversold)' : indicators.rsi > 50 ? '(bullish)' : '(bearish)'
    : undefined;

  const adxInterp = indicators.adx !== null
    ? indicators.adx >= 25 ? '(trending)' : '(weak trend)'
    : undefined;

  const macdInterp = indicators.macd
    ? indicators.macd.histogram > 0 ? '(bullish)' : '(bearish)'
    : undefined;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))] mb-1">Momentum</p>
        {row('RSI(14)', indicators.rsi?.toFixed(1) ?? null, rsiInterp)}
        {row('MACD', indicators.macd ? `${indicators.macd.value}` : null, macdInterp)}
        {indicators.macd && row('  Signal', indicators.macd.signal.toFixed(2))}
        {indicators.macd && row('  Histogram', `${indicators.macd.histogram > 0 ? '+' : ''}${indicators.macd.histogram}`)}
      </div>
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))] mb-1">Trend & Volatility</p>
        {row('EMA(20)', indicators.ema20?.toFixed(2) ?? null)}
        {row('SMA(50)', indicators.sma50?.toFixed(2) ?? null)}
        {row('SMA(200)', indicators.sma200?.toFixed(2) ?? null)}
        {row('ADX(14)', indicators.adx?.toFixed(1) ?? null, adxInterp)}
        {row('ATR(14)', indicators.atr?.toFixed(2) ?? null)}
        {row('Vol Ratio', indicators.volumeRatio?.toFixed(2) ?? null, indicators.volumeRatio ? `(${indicators.volumeRatio > 1.2 ? 'above avg' : indicators.volumeRatio < 0.8 ? 'below avg' : 'normal'})` : undefined)}
      </div>
      {/* Crossover & Trend — full width */}
      <div className="col-span-1 sm:col-span-2 mt-1 pt-2 border-t border-[hsl(var(--border))]">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))] mb-1">Signals</p>
        {row('MA Crossover', indicators.emaCrossover ? {
          bullish_cross: 'Bullish cross',
          bearish_cross: 'Bearish cross',
          above: 'EMA > SMA',
          below: 'EMA < SMA',
        }[indicators.emaCrossover] : null, indicators.emaCrossover === 'bullish_cross' ? '(EMA20 just crossed above SMA50)' : indicators.emaCrossover === 'bearish_cross' ? '(EMA20 just crossed below SMA50)' : undefined)}
        {row('Trend', indicators.trend ? {
          strong_uptrend: 'Strong Uptrend',
          uptrend: 'Uptrend',
          sideways: 'Sideways',
          downtrend: 'Downtrend',
          strong_downtrend: 'Strong Downtrend',
        }[indicators.trend] : null, indicators.trend === 'strong_uptrend' ? '(price > SMA50 > SMA200)' : indicators.trend === 'strong_downtrend' ? '(price < SMA50 < SMA200)' : undefined)}
      </div>
    </div>
  );
}

// ── Long Term Outlook ───────────────────────────────────

function OutlookSection({ outlook }: { outlook: LongTermOutlook }) {
  const ratingColors: Record<string, { bg: string; text: string; border: string }> = {
    'Strong Buy': { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' },
    Buy: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200' },
    Neutral: { bg: 'bg-gray-50', text: 'text-gray-600', border: 'border-gray-200' },
    Sell: { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200' },
    'Strong Sell': { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
  };
  const colors = ratingColors[outlook.rating] ?? ratingColors.Neutral;

  // Score color
  let scoreColor: string;
  if (outlook.score >= 7) scoreColor = '#22c55e';
  else if (outlook.score >= 4) scoreColor = '#f59e0b';
  else scoreColor = '#ef4444';

  return (
    <div className={cn('rounded-xl border p-4', colors.border, colors.bg)}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <TrendingUp className="w-4 h-4 text-[hsl(var(--muted-foreground))]" />
          <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">Long Term Outlook</h3>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="text-xs font-bold tabular-nums" style={{ color: scoreColor }}>
            {outlook.score}/10
          </span>
          <span className={cn(
            'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border',
            colors.bg, colors.text, colors.border,
          )}>
            {outlook.rating}
          </span>
        </div>
      </div>
      {outlook.summary && (
        <p className="text-sm text-[hsl(var(--muted-foreground))] leading-relaxed mb-3">{outlook.summary}</p>
      )}
      {outlook.keyFactors.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {outlook.keyFactors.map((factor, i) => (
            <span
              key={i}
              className="inline-flex items-center rounded-full bg-white/70 border border-[hsl(var(--border))] px-2 py-0.5 text-[11px] text-[hsl(var(--muted-foreground))]"
            >
              {factor}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Chart ───────────────────────────────────────────────

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

    const lineColors: Record<string, string> = {
      Entry: '#4da6ff',
      Stop: '#ef5350',
      'Target 1': '#26a69a',
      'Target 2': '#0d9488',
    };

    overlays.forEach((o) => {
      const lineColor = lineColors[o.label] ?? '#94a3b8';
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

// ── Signal Cache ────────────────────────────────────────
// Swing signals are based on 4h/daily/weekly candles — stable for 15+ min.
// Day trade signals use 1m/15m/1h — shorter shelf life.
// Auto results are cached under their resolved mode so switching manually
// to that mode serves the same result instantly.

interface CacheEntry {
  data: TradingSignalsResponse;
  timestamp: number;
}

const CACHE_TTL_MS: Record<string, number> = {
  SWING_TRADE: 15 * 60 * 1000, // 15 minutes
  DAY_TRADE: 3 * 60 * 1000,    // 3 minutes
};

const signalCache = new Map<string, CacheEntry>();

function getCacheKey(ticker: string, resolvedMode: string): string {
  return `${ticker}_${resolvedMode}`;
}

function getCached(ticker: string, resolvedMode: string): TradingSignalsResponse | null {
  const entry = signalCache.get(getCacheKey(ticker, resolvedMode));
  if (!entry) return null;
  const ttl = CACHE_TTL_MS[resolvedMode] ?? CACHE_TTL_MS.SWING_TRADE;
  if (Date.now() - entry.timestamp > ttl) {
    signalCache.delete(getCacheKey(ticker, resolvedMode));
    return null;
  }
  return entry.data;
}

function setCache(ticker: string, data: TradingSignalsResponse): void {
  // Resolve the actual mode (Auto → detected mode, or explicit mode)
  const resolvedMode = data.trade.detectedMode ?? data.trade.mode;
  const key = getCacheKey(ticker, resolvedMode.replace(' ', '_').toUpperCase());
  signalCache.set(key, { data, timestamp: Date.now() });
}

function formatAge(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  return `${Math.round(sec / 60)}m ago`;
}

// ── Main Component ──────────────────────────────────────

export function TradingSignals() {
  const [ticker, setTicker] = useState('');
  const [mode, setMode] = useState<SignalsMode>(() => getStoredMode());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TradingSignalsResponse | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [cacheAge, setCacheAge] = useState(0);
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
    setError(null);

    // Check if we have a cached result for this mode + current ticker
    const sym = ticker.trim().toUpperCase();
    if (sym) {
      const checkModes = m === 'AUTO' ? ['DAY_TRADE', 'SWING_TRADE'] : [m];
      for (const cm of checkModes) {
        const cached = getCached(sym, cm);
        if (cached) {
          setResult(cached);
          setFromCache(true);
          const entry = signalCache.get(getCacheKey(sym, cm));
          setCacheAge(entry ? Date.now() - entry.timestamp : 0);
          return;
        }
      }
    }
    setResult(null);
    setFromCache(false);
  };

  const fetchSignal = async (sym: string, forceRefresh = false, modeOverride?: SignalsMode) => {
    const effectiveMode = modeOverride ?? mode;
    setError(null);
    setFromCache(false);

    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const checkModes = effectiveMode === 'AUTO' ? ['DAY_TRADE', 'SWING_TRADE'] : [effectiveMode];
      for (const cm of checkModes) {
        const cached = getCached(sym, cm);
        if (cached) {
          setResult(cached);
          setFromCache(true);
          const entry = signalCache.get(getCacheKey(sym, cm));
          setCacheAge(entry ? Date.now() - entry.timestamp : 0);
          return;
        }
      }
    }

    setLoading(true);
    setResult(null);
    try {
      const data = await fetchTradingSignal(sym, effectiveMode);
      setCache(sym, data);
      setResult(data);
      setFromCache(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch signal');
    } finally {
      setLoading(false);
    }
  };

  const handleSelectIdea = (t: string, m: 'DAY_TRADE' | 'SWING_TRADE') => {
    setTicker(t);
    setMode(m);
    setStoredMode(m);
    setResult(null);  // Clear stale result so old analysis doesn't show
    setError(null);
    // Don't auto-run the full AI analysis — let the user click Analyze.
    // Just populate the ticker + mode so they can review before running.
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
    if (sym) fetchSignal(sym, true); // force refresh — always bypasses cache
  };

  const modeButtons: { value: SignalsMode; label: string }[] = [
    { value: 'AUTO', label: 'Auto' },
    { value: 'SWING_TRADE', label: 'Swing' },
    { value: 'DAY_TRADE', label: 'Day' },
  ];

  const modeDescription: Record<SignalsMode, string> = {
    AUTO: 'Automatically picks Day or Swing based on volatility',
    DAY_TRADE: '1m · 15m · 1h candles + live news sentiment',
    SWING_TRADE: '4h · daily · weekly candles + news sentiment',
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
          AI-powered signals with technical indicators, scenario analysis, and market context.
        </p>
      </div>

      {/* Trade Ideas — auto-scanned high-confidence picks */}
      <TradeIdeas onSelectTicker={handleSelectIdea} />

      {/* Static indicators — always visible */}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))] mr-1">Indicators</span>
        {[
          { name: 'RSI', param: '14' },
          { name: 'MACD', param: '12/26/9' },
          { name: 'EMA', param: '20' },
          { name: 'SMA', param: '50 · 200' },
          { name: 'ATR', param: '14' },
          { name: 'ADX', param: '14' },
          { name: 'Volume', param: '20d avg' },
          { name: 'S/R', param: 'swing H/L' },
          { name: 'MA Cross', param: 'EMA20/SMA50' },
        ].map((i) => (
          <span key={i.name} className="rounded-full bg-[hsl(var(--secondary))] border border-[hsl(var(--border))] px-2 py-0.5 text-[hsl(var(--muted-foreground))]">
            <span className="font-medium text-[hsl(var(--foreground))]">{i.name}</span> ({i.param})
          </span>
        ))}
      </div>

      <div className="space-y-2">
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
              {modeButtons.map((btn) => (
                <button
                  key={btn.value}
                  type="button"
                  onClick={() => handleModeChange(btn.value)}
                  className={cn(
                    'px-4 py-2 text-sm font-medium rounded-md transition-all',
                    mode === btn.value
                      ? 'bg-white text-[hsl(var(--foreground))] shadow-sm'
                      : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
                  )}
                >
                  {btn.label}
                </button>
              ))}
            </div>
          </div>
          <button
            type="submit"
            disabled={loading}
            className="flex items-center gap-2 rounded-lg bg-[hsl(var(--primary))] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[hsl(221,83%,48%)] hover:shadow-lg hover:shadow-blue-500/25 disabled:opacity-60 transition-all"
          >
            {loading ? (
              <>
                <Spinner size="md" /> Getting signal… <span className="tabular-nums text-white/70">{elapsed}s</span>
              </>
            ) : (
              <>
                <Activity className="h-4 w-4" /> Get signal
              </>
            )}
          </button>
        </form>
        <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
          {modeDescription[mode]}
        </p>
      </div>

      {error && <ErrorBanner message={error} />}

      {result && (
        <div className="space-y-4 animate-fade-in-up">
          {/* Auto-detection reasoning */}
          {result.trade.autoReason && (
            <div className="rounded-xl bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 px-4 py-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100">
                  <Zap className="w-3.5 h-3.5 text-blue-600" />
                </span>
                <span className="font-bold text-blue-800">
                  Auto selected{' '}
                  <span className={cn(
                    'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold uppercase tracking-wide',
                    result.trade.detectedMode?.includes('DAY')
                      ? 'bg-amber-100 text-amber-800 border border-amber-300'
                      : 'bg-indigo-100 text-indigo-800 border border-indigo-300'
                  )}>
                    {result.trade.detectedMode?.replace('_', ' ')}
                  </span>
                </span>
              </div>
              <p className="mt-1.5 ml-8 text-xs text-blue-700 leading-relaxed">{result.trade.autoReason}</p>
            </div>
          )}

          {/* Market snapshot banner */}
          {result.marketSnapshot && <MarketBanner snapshot={result.marketSnapshot} />}

          {/* Signal card */}
          <div className={cn(
            'rounded-xl border bg-white p-6 shadow-md',
            result.trade.recommendation === 'BUY' && 'border-emerald-200',
            result.trade.recommendation === 'SELL' && 'border-red-200',
            result.trade.recommendation === 'HOLD' && 'border-amber-200',
          )}>
            {/* Header row: signal badge + bias + confidence + refresh */}
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <SignalBadge signal={result.trade.recommendation} size="lg" pulse />
                <div className="flex flex-col">
                  {result.trade.bias && (
                    <span className="text-sm font-medium text-[hsl(var(--foreground))]">{result.trade.bias}</span>
                  )}
                  <span className="text-xs text-[hsl(var(--muted-foreground))]">
                    {result.trade.mode.replace('_', ' ')}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="relative flex items-center">
                  <ConfidenceScore score={result.trade.confidence} />
                  <span className="ml-1 text-[10px] text-[hsl(var(--muted-foreground))]">/10</span>
                </div>
                {fromCache && (
                  <span className="text-[10px] text-[hsl(var(--muted-foreground))] bg-[hsl(var(--secondary))] px-2 py-0.5 rounded-full" title="Served from cache — click Refresh for a fresh signal">
                    cached · {formatAge(cacheAge)}
                  </span>
                )}
                <button
                  type="button"
                  onClick={handleRefresh}
                  disabled={loading}
                  className="flex items-center gap-1.5 rounded-lg border border-[hsl(var(--input))] px-3 py-1.5 text-xs font-medium text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))] disabled:opacity-60 transition-colors"
                  title="Refresh signal (bypasses cache)"
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Refresh
                </button>
              </div>
            </div>

            {/* Stat cards */}
            {result.trade.recommendation === 'HOLD' ? (
              <div className="mt-4 rounded-lg bg-[hsl(var(--secondary))] px-4 py-3 text-sm text-[hsl(var(--muted-foreground))]">
                No trade recommended right now — conditions don't meet the criteria. Check back later or try a different mode.
              </div>
            ) : (
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
                <StatCard label="Entry" value={formatPrice(result.trade.entryPrice)} color="blue" />
                <StatCard label="Stop" value={formatPrice(result.trade.stopLoss)} color="red" />
                <StatCard label="Target 1" value={formatPrice(result.trade.targetPrice)} color="green" />
                <StatCard label="Target 2" value={formatPrice(result.trade.targetPrice2)} color="green" />
                <StatCard label="R:R" value={result.trade.riskReward ?? '—'} color="purple" />
              </div>
            )}

            {/* Rationale */}
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

          {/* Scenario Analysis — always visible, core to the signal */}
          {result.trade.scenarios && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Zap className="w-4 h-4 text-amber-600" />
                <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">Scenario Analysis</h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <ScenarioCard
                  label="Bullish"
                  probability={result.trade.scenarios.bullish.probability}
                  summary={result.trade.scenarios.bullish.summary}
                  color="green"
                />
                <ScenarioCard
                  label="Neutral"
                  probability={result.trade.scenarios.neutral.probability}
                  summary={result.trade.scenarios.neutral.summary}
                  color="gray"
                />
                <ScenarioCard
                  label="Bearish"
                  probability={result.trade.scenarios.bearish.probability}
                  summary={result.trade.scenarios.bearish.summary}
                  color="red"
                />
              </div>
            </div>
          )}

          {/* Long Term Outlook — fundamentals-powered assessment */}
          {result.longTermOutlook && (
            <OutlookSection outlook={result.longTermOutlook} />
          )}

          {/* Technical Indicators — collapsed with inline preview */}
          {result.indicators && (
            <CollapsibleSection
              title="Technical Indicators"
              icon={<BarChart3 className="w-4 h-4 text-blue-600" />}
              accentColor="blue"
              preview={
                <div className="flex flex-wrap gap-2">
                  {result.indicators.rsi != null && (
                    <span className={cn(
                      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border',
                      result.indicators.rsi > 70 ? 'bg-red-50 text-red-700 border-red-200' :
                      result.indicators.rsi < 30 ? 'bg-green-50 text-green-700 border-green-200' :
                      result.indicators.rsi > 50 ? 'bg-blue-50 text-blue-700 border-blue-200' :
                      'bg-orange-50 text-orange-700 border-orange-200'
                    )}>
                      RSI {result.indicators.rsi.toFixed(0)}
                    </span>
                  )}
                  {result.indicators.macd && (
                    <span className={cn(
                      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border',
                      result.indicators.macd.histogram > 0
                        ? 'bg-green-50 text-green-700 border-green-200'
                        : 'bg-red-50 text-red-700 border-red-200'
                    )}>
                      MACD {result.indicators.macd.histogram > 0 ? 'Bullish' : 'Bearish'}
                    </span>
                  )}
                  {result.indicators.trend && (
                    <span className={cn(
                      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border',
                      result.indicators.trend.includes('uptrend') ? 'bg-green-50 text-green-700 border-green-200' :
                      result.indicators.trend.includes('downtrend') ? 'bg-red-50 text-red-700 border-red-200' :
                      'bg-gray-50 text-gray-600 border-gray-200'
                    )}>
                      {{
                        strong_uptrend: 'Strong Uptrend',
                        uptrend: 'Uptrend',
                        sideways: 'Sideways',
                        downtrend: 'Downtrend',
                        strong_downtrend: 'Strong Downtrend',
                      }[result.indicators.trend] ?? result.indicators.trend}
                    </span>
                  )}
                  {result.indicators.adx != null && (
                    <span className={cn(
                      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border',
                      result.indicators.adx >= 25
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-gray-50 text-gray-600 border-gray-200'
                    )}>
                      ADX {result.indicators.adx.toFixed(0)} {result.indicators.adx >= 25 ? 'Trending' : 'Weak'}
                    </span>
                  )}
                  {result.indicators.volumeRatio != null && (
                    <span className={cn(
                      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border',
                      result.indicators.volumeRatio > 1.2
                        ? 'bg-blue-50 text-blue-700 border-blue-200'
                        : 'bg-gray-50 text-gray-600 border-gray-200'
                    )}>
                      Vol {result.indicators.volumeRatio.toFixed(1)}x
                    </span>
                  )}
                </div>
              }
            >
              <IndicatorsPanel indicators={result.indicators} />
            </CollapsibleSection>
          )}

          {/* Chart */}
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

          {/* Disclaimer */}
          <p className="text-center text-[11px] text-[hsl(var(--muted-foreground))]">
            For educational purposes only. Not financial advice.
          </p>
        </div>
      )}
    </div>
  );
}
