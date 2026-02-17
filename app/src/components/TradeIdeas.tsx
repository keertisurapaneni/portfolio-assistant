import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Flame,
  TrendingUp,
  RefreshCw,
  Zap,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  BarChart3,
  AlertTriangle,
  Bot,
  CheckCircle,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { fetchTradeIdeas, type TradeIdea, type ScanResult } from '../lib/tradeScannerApi';
import {
  getAutoTraderConfig,
  processTradeIdeas,
  type ProcessResult,
} from '../lib/autoTrader';
import { getActiveTrades, getAllTrades } from '../lib/paperTradesApi';
import { Spinner } from './Spinner';

// ── Client-side cache ───────────────────────────────────

let _cache: ScanResult | null = null;
let _cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 min client-side (DB has its own TTL)

// ── Props ───────────────────────────────────────────────

interface TradeIdeasProps {
  onSelectTicker: (ticker: string, mode: 'DAY_TRADE' | 'SWING_TRADE') => void;
}

type Tab = 'day' | 'swing';

function formatScanAge(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(diffMs / 3600000);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ts).toLocaleDateString();
}

// ── Main Component ──────────────────────────────────────

export function TradeIdeas({ onSelectTicker }: TradeIdeasProps) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<Tab>('day');
  const [data, setData] = useState<ScanResult | null>(_cache);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoTrading, setAutoTrading] = useState(false);
  const [, setAutoTradeResults] = useState<ProcessResult[]>([]);
  const [tradedTickers, setTradedTickers] = useState<Set<string>>(new Set());
  const processedRef = useRef<Set<string>>(new Set()); // track already-processed tickers

  // Load tickers that already have paper trades (active or recent)
  useEffect(() => {
    Promise.all([getActiveTrades(), getAllTrades(50)])
      .then(([active, all]) => {
        const tickers = new Set<string>();
        active.forEach(t => tickers.add(t.ticker.toUpperCase()));
        all.forEach(t => tickers.add(t.ticker.toUpperCase()));
        setTradedTickers(tickers);
      })
      .catch(console.error);
  }, []);

  const load = useCallback(async (force = false) => {
    if (!force && _cache && Date.now() - _cacheTime < CACHE_TTL) {
      setData(_cache);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await fetchTradeIdeas();
      _cache = result;
      _cacheTime = Date.now();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to scan');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-trade: when new data arrives and auto-trading is enabled,
  // process any new ideas that haven't been processed yet
  useEffect(() => {
    if (!data) return;
    const config = getAutoTraderConfig();
    if (!config.enabled) return;

    const allIdeas = [...(data.dayTrades ?? []), ...(data.swingTrades ?? [])];
    const newIdeas = allIdeas.filter(i => !processedRef.current.has(i.ticker));
    if (newIdeas.length === 0) return;

    // Mark as processing so we don't re-trigger
    newIdeas.forEach(i => processedRef.current.add(i.ticker));

    setAutoTrading(true);
    processTradeIdeas(newIdeas, config)
      .then(results => {
        setAutoTradeResults(prev => [...results, ...prev].slice(0, 20));
      })
      .catch(console.error)
      .finally(() => setAutoTrading(false));
  }, [data]);

  const dayIdeas = data?.dayTrades ?? [];
  const swingIdeas = data?.swingTrades ?? [];
  const ideas = tab === 'day' ? dayIdeas : swingIdeas;
  const totalCount = dayIdeas.length + swingIdeas.length;

  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-white shadow-sm overflow-hidden">
      {/* Header — always visible, click to expand/collapse */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gradient-to-r from-[hsl(var(--secondary))] to-white hover:from-[hsl(var(--accent))] transition-colors"
      >
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-6 h-6 rounded-full bg-amber-100">
            <Zap className="w-3.5 h-3.5 text-amber-600" />
          </div>
          <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">Trade Ideas</h3>
          {totalCount > 0 && (
            <span className="text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5 py-0.5 rounded-full">
              {totalCount} setups
            </span>
          )}
          {data?.timestamp && !loading && (
            <span className="text-[10px] text-[hsl(var(--muted-foreground))]/60">
              &middot; Scanned {formatScanAge(data.timestamp)}
              {data.cached && ' (cached)'}
            </span>
          )}
          {loading && <Spinner size="xs" className="text-amber-500" />}
          {autoTrading && (
            <span className="flex items-center gap-1 text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded-full">
              <Bot className="w-3 h-3 animate-pulse" />
              Auto-executing...
            </span>
          )}
          {getAutoTraderConfig().enabled && !autoTrading && (
            <span className="flex items-center gap-1 text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5 py-0.5 rounded-full">
              <Bot className="w-3 h-3" />
              AUTO
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); load(true); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); load(true); } }}
            className="flex items-center gap-1 text-[11px] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors"
          >
            <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
          </span>
          {expanded
            ? <ChevronUp className="w-4 h-4 text-[hsl(var(--muted-foreground))]" />
            : <ChevronDown className="w-4 h-4 text-[hsl(var(--muted-foreground))]" />}
        </div>
      </button>

      {/* Collapsed preview — horizontal ticker pills */}
      {!expanded && ideas.length > 0 && (
        <div className="px-4 pb-3 flex flex-wrap gap-1.5">
          {ideas.slice(0, 5).map((idea) => {
            const isTraded = tradedTickers.has(idea.ticker.toUpperCase());
            return (
              <button
                key={idea.ticker}
                type="button"
                onClick={() => onSelectTicker(idea.ticker, idea.mode)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-all',
                  'hover:shadow-sm hover:-translate-y-px',
                  isTraded
                    ? 'bg-emerald-50/60 border-emerald-300'
                    : 'bg-white border-[hsl(var(--border))]'
                )}
              >
                {isTraded && <CheckCircle className="w-3 h-3 text-emerald-500" />}
                <span className={cn(
                  'inline-flex items-center px-1.5 py-0 rounded text-[9px] font-bold',
                  idea.signal === 'BUY'
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-red-100 text-red-700'
                )}>
                  {idea.signal}
                </span>
                <span className="font-bold text-[hsl(var(--foreground))]">{idea.ticker}</span>
                <span className={cn(
                  'tabular-nums',
                  idea.changePercent >= 0 ? 'text-green-600' : 'text-red-600'
                )}>
                  {idea.changePercent >= 0 ? '+' : ''}{idea.changePercent}%
                </span>
                <ConfidenceRing score={idea.confidence} size="sm" />
              </button>
            );
          })}
          {ideas.length > 5 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-[hsl(var(--border))] px-2.5 py-1 text-[11px] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))] transition-colors"
            >
              +{ideas.length - 5} more
            </button>
          )}
        </div>
      )}

      {/* Collapsed loading */}
      {!expanded && loading && !data && (
        <div className="px-4 pb-3 flex items-center gap-2 text-[11px] text-[hsl(var(--muted-foreground))]">
          <Spinner size="xs" /> Scanning market...
        </div>
      )}

      {/* Expanded view */}
      {expanded && (
        <div className="border-t border-[hsl(var(--border))]">
          {/* Tabs */}
          <div className="flex px-4 pt-3 gap-1">
            <button
              type="button"
              onClick={() => setTab('day')}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all',
                tab === 'day'
                  ? 'bg-amber-50 text-amber-700 border border-amber-200 shadow-sm'
                  : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))]'
              )}
            >
              <Flame className="w-3.5 h-3.5" />
              Day Trades
              {dayIdeas.length > 0 && (
                <span className={cn(
                  'ml-0.5 text-[10px] px-1.5 rounded-full font-semibold',
                  tab === 'day' ? 'bg-amber-200/70 text-amber-700' : 'bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))]'
                )}>
                  {dayIdeas.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setTab('swing')}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all',
                tab === 'swing'
                  ? 'bg-blue-50 text-blue-700 border border-blue-200 shadow-sm'
                  : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))]'
              )}
            >
              <TrendingUp className="w-3.5 h-3.5" />
              Swing Trades
              {swingIdeas.length > 0 && (
                <span className={cn(
                  'ml-0.5 text-[10px] px-1.5 rounded-full font-semibold',
                  tab === 'swing' ? 'bg-blue-200/70 text-blue-700' : 'bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))]'
                )}>
                  {swingIdeas.length}
                </span>
              )}
            </button>
          </div>

          {/* Caution banner */}
          <div className="mx-4 mt-2.5 flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200/70 px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
            <p className="text-[11px] leading-snug text-amber-700">
              AI-screened ideas with candle validation. Run a <span className="font-semibold">full analysis</span> for
              entry/exit levels, risk sizing, and multi-timeframe confirmation before trading.
            </p>
          </div>

          {/* Content */}
          <div className="p-4 pt-3">
            {loading && !data && (
              <div className="flex items-center justify-center py-8 gap-2 text-sm text-[hsl(var(--muted-foreground))]">
                <Spinner size="md" />
                <span>Scanning market for setups...</span>
              </div>
            )}

            {error && !data && (
              <p className="text-sm text-red-600 py-4 text-center">{error}</p>
            )}

            {ideas.length === 0 && !loading && !error && data && (
              <div className="flex flex-col items-center py-6 gap-2 text-center">
                <BarChart3 className="w-8 h-8 text-[hsl(var(--muted-foreground))] opacity-40" />
                <p className="text-sm text-[hsl(var(--muted-foreground))]">
                  {tab === 'day'
                    ? 'No high-confidence day trade setups right now.'
                    : 'No confirmed swing setups found.'}
                </p>
                <p className="text-xs text-[hsl(var(--muted-foreground))] opacity-70">
                  Market may be closed or the AI didn't find setups worth recommending.
                </p>
              </div>
            )}

            {ideas.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5">
                {ideas.map((idea) => (
                  <IdeaCard
                    key={idea.ticker}
                    idea={idea}
                    traded={tradedTickers.has(idea.ticker.toUpperCase())}
                    onSelect={onSelectTicker}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Confidence Ring ──────────────────────────────────────
// Same visual as the full Trade Signal analysis confidence ring.
// Score is already 0-10 from the AI.

function ConfidenceRing({ score, size = 'md' }: { score: number; size?: 'sm' | 'md' }) {
  const clamped = Math.max(0, Math.min(10, Math.round(score)));
  const pct = clamped / 10;

  const dim = size === 'sm' ? 22 : 36;
  const radius = size === 'sm' ? 8 : 14;
  const strokeWidth = size === 'sm' ? 2.5 : 3.5;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pct);

  let color: string;
  if (clamped >= 7) color = '#22c55e';       // green
  else if (clamped >= 4) color = '#f59e0b';  // amber
  else color = '#ef4444';                     // red

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: dim, height: dim }}>
      <svg width={dim} height={dim} className="transform -rotate-90">
        <circle
          cx={dim / 2} cy={dim / 2} r={radius}
          stroke="#e5e7eb" strokeWidth={strokeWidth} fill="none"
        />
        <circle
          cx={dim / 2} cy={dim / 2} r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-500"
        />
      </svg>
      <span
        className="absolute font-bold"
        style={{ color, fontSize: size === 'sm' ? '8px' : '11px', lineHeight: 1 }}
      >
        {clamped}
      </span>
    </div>
  );
}

// ── Signal Badge ────────────────────────────────────────

function SignalPill({ signal }: { signal: 'BUY' | 'SELL' }) {
  return (
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-extrabold tracking-wide',
      signal === 'BUY'
        ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
        : 'bg-red-100 text-red-800 border border-red-200'
    )}>
      {signal}
    </span>
  );
}

// ── Idea Card ───────────────────────────────────────────

function IdeaCard({
  idea,
  traded,
  onSelect,
}: {
  idea: TradeIdea;
  traded: boolean;
  onSelect: (ticker: string, mode: 'DAY_TRADE' | 'SWING_TRADE') => void;
}) {
  const isPositive = idea.changePercent >= 0;

  return (
    <button
      type="button"
      onClick={() => onSelect(idea.ticker, idea.mode)}
      className={cn(
        'group relative flex flex-col rounded-lg border p-3 text-left transition-all duration-200',
        'hover:shadow-md hover:border-[hsl(var(--ring))] hover:-translate-y-0.5',
        traded
          ? 'bg-emerald-50/40 border-emerald-300'
          : 'bg-white border-[hsl(var(--border))]'
      )}
    >
      {/* Traded badge */}
      {traded && (
        <div className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-100 border border-emerald-200">
          <CheckCircle className="w-3 h-3 text-emerald-600" />
          <span className="text-[9px] font-bold text-emerald-700">TRADED</span>
        </div>
      )}

      {/* Top row: signal + ticker + confidence ring + change% */}
      <div className="flex items-center justify-between w-full gap-2">
        <div className="flex items-center gap-2">
          <SignalPill signal={idea.signal} />
          <span className="text-sm font-bold text-[hsl(var(--foreground))]">{idea.ticker}</span>
          <div className="flex items-center gap-0.5">
            <ConfidenceRing score={idea.confidence} size="md" />
            <span className="text-[8px] text-[hsl(var(--muted-foreground))]">/10</span>
          </div>
        </div>
        {!traded && (
          <span className={cn(
            'text-xs font-bold tabular-nums px-1.5 py-0.5 rounded-md',
            isPositive ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
          )}>
            {isPositive ? '+' : ''}{idea.changePercent}%
          </span>
        )}
      </div>

      {/* Name + price */}
      <div className="flex items-center justify-between w-full mt-1">
        <span className="text-[11px] text-[hsl(var(--muted-foreground))] truncate max-w-[55%]">
          {idea.name}
        </span>
        <span className="text-[11px] font-medium text-[hsl(var(--foreground))] tabular-nums">
          ${idea.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      </div>

      {/* AI reason */}
      <p className="mt-1.5 text-[11px] text-[hsl(var(--muted-foreground))] leading-snug line-clamp-2">
        {idea.reason}
      </p>

      {/* Tags row */}
      {idea.tags.length > 0 && (
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          {idea.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center rounded-full px-1.5 py-0 text-[9px] font-medium border bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))] border-[hsl(var(--border))]"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Analyze CTA */}
      <div className="flex items-center gap-1 mt-2 text-[10px] font-semibold text-[hsl(var(--muted-foreground))] group-hover:text-[hsl(var(--primary))] transition-colors">
        Run full analysis <ChevronRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
      </div>
    </button>
  );
}
