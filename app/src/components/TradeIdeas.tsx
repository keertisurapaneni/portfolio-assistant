import { useState, useEffect, useCallback } from 'react';
import {
  Flame,
  TrendingUp,
  RefreshCw,
  Zap,
  ChevronRight,
  BarChart3,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { fetchTradeIdeas, type TradeIdea, type ScanResult } from '../lib/tradeScannerApi';
import { Spinner } from './Spinner';

// ── Client-side cache ───────────────────────────────────
// Scanner results are stable intraday — cache 10 min on the client too.

let _cache: ScanResult | null = null;
let _cacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000;

// ── Props ───────────────────────────────────────────────

interface TradeIdeasProps {
  onSelectTicker: (ticker: string, mode: 'DAY_TRADE' | 'SWING_TRADE') => void;
}

type Tab = 'day' | 'swing';

// ── Main Component ──────────────────────────────────────

export function TradeIdeas({ onSelectTicker }: TradeIdeasProps) {
  const [tab, setTab] = useState<Tab>('day');
  const [data, setData] = useState<ScanResult | null>(_cache);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const ideas = tab === 'day' ? (data?.dayTrades ?? []) : (data?.swingTrades ?? []);

  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(var(--border))] bg-gradient-to-r from-[hsl(var(--secondary))] to-white">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-6 h-6 rounded-full bg-amber-100">
            <Zap className="w-3.5 h-3.5 text-amber-600" />
          </div>
          <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">Trade Ideas</h3>
          <span className="text-[10px] text-[hsl(var(--muted-foreground))] bg-[hsl(var(--secondary))] border border-[hsl(var(--border))] px-1.5 py-0.5 rounded-full">
            high-confidence
          </span>
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading}
          className="flex items-center gap-1 text-[11px] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
          {loading ? 'Scanning...' : 'Refresh'}
        </button>
      </div>

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
          {data && data.dayTrades.length > 0 && (
            <span className={cn(
              'ml-0.5 text-[10px] px-1.5 rounded-full font-semibold',
              tab === 'day' ? 'bg-amber-200/70 text-amber-700' : 'bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))]'
            )}>
              {data.dayTrades.length}
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
          {data && data.swingTrades.length > 0 && (
            <span className={cn(
              'ml-0.5 text-[10px] px-1.5 rounded-full font-semibold',
              tab === 'swing' ? 'bg-blue-200/70 text-blue-700' : 'bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))]'
            )}>
              {data.swingTrades.length}
            </span>
          )}
        </button>
      </div>

      {/* Content */}
      <div className="p-4 pt-3">
        {/* Loading state */}
        {loading && !data && (
          <div className="flex items-center justify-center py-8 gap-2 text-sm text-[hsl(var(--muted-foreground))]">
            <Spinner size="md" />
            <span>Scanning market for setups...</span>
          </div>
        )}

        {/* Error state */}
        {error && !data && (
          <p className="text-sm text-red-600 py-4 text-center">{error}</p>
        )}

        {/* Empty state */}
        {ideas.length === 0 && !loading && !error && data && (
          <div className="flex flex-col items-center py-6 gap-2 text-center">
            <BarChart3 className="w-8 h-8 text-[hsl(var(--muted-foreground))] opacity-40" />
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              {tab === 'day'
                ? 'No high-confidence day trade setups right now.'
                : 'No confirmed pullback-in-uptrend setups found.'}
            </p>
            <p className="text-xs text-[hsl(var(--muted-foreground))] opacity-70">
              Market may be closed or conditions don't meet the criteria.
            </p>
          </div>
        )}

        {/* Ideas grid */}
        {ideas.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {ideas.map((idea) => (
              <IdeaCard
                key={idea.ticker}
                idea={idea}
                onSelect={onSelectTicker}
                accentColor={tab === 'day' ? 'amber' : 'blue'}
              />
            ))}
          </div>
        )}

        {/* Subtle description */}
        {ideas.length > 0 && (
          <p className="mt-3 text-center text-[10px] text-[hsl(var(--muted-foreground))] opacity-70">
            {tab === 'day'
              ? 'Ranked by momentum + volume confirmation. Click to run full AI analysis.'
              : 'Ranked by uptrend strength + pullback quality. Click to run full AI analysis.'}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Score Bar ───────────────────────────────────────────

function ScoreBar({ score, color }: { score: number; color: 'amber' | 'blue' }) {
  const barColor = color === 'amber' ? 'bg-amber-500' : 'bg-blue-500';
  const bgColor = color === 'amber' ? 'bg-amber-100' : 'bg-blue-100';
  const textColor = color === 'amber' ? 'text-amber-700' : 'text-blue-700';

  return (
    <div className="flex items-center gap-1.5">
      <div className={cn('flex-1 h-1 rounded-full', bgColor)}>
        <div
          className={cn('h-full rounded-full transition-all duration-500', barColor)}
          style={{ width: `${score}%` }}
        />
      </div>
      <span className={cn('text-[10px] font-bold tabular-nums', textColor)}>{score}</span>
    </div>
  );
}

// ── Idea Card ───────────────────────────────────────────

function IdeaCard({
  idea,
  onSelect,
  accentColor,
}: {
  idea: TradeIdea;
  onSelect: (ticker: string, mode: 'DAY_TRADE' | 'SWING_TRADE') => void;
  accentColor: 'amber' | 'blue';
}) {
  const isPositive = idea.changePercent >= 0;

  return (
    <button
      type="button"
      onClick={() => onSelect(idea.ticker, idea.mode)}
      className={cn(
        'group relative flex flex-col rounded-lg border p-3 text-left transition-all duration-200',
        'hover:shadow-md hover:border-[hsl(var(--ring))] hover:-translate-y-0.5',
        'bg-white border-[hsl(var(--border))]'
      )}
    >
      {/* Top row: ticker + change% */}
      <div className="flex items-center justify-between w-full">
        <span className="text-sm font-bold text-[hsl(var(--foreground))]">{idea.ticker}</span>
        <span className={cn(
          'text-xs font-bold tabular-nums px-1.5 py-0.5 rounded-md',
          isPositive
            ? 'bg-green-50 text-green-700'
            : 'bg-red-50 text-red-700'
        )}>
          {isPositive ? '+' : ''}{idea.changePercent}%
        </span>
      </div>

      {/* Name + price */}
      <div className="flex items-center justify-between w-full mt-0.5">
        <span className="text-[11px] text-[hsl(var(--muted-foreground))] truncate max-w-[55%]">
          {idea.name}
        </span>
        <span className="text-[11px] font-medium text-[hsl(var(--foreground))] tabular-nums">
          ${idea.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      </div>

      {/* Reason */}
      <p className="mt-2 text-[11px] text-[hsl(var(--muted-foreground))] leading-snug line-clamp-2">
        {idea.reason}
      </p>

      {/* Tags */}
      {idea.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {idea.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className={cn(
                'inline-flex items-center rounded-full px-1.5 py-0 text-[9px] font-medium border',
                accentColor === 'amber'
                  ? 'bg-amber-50 text-amber-600 border-amber-200'
                  : 'bg-blue-50 text-blue-600 border-blue-200'
              )}
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Score bar */}
      <div className="mt-2">
        <ScoreBar score={idea.score} color={accentColor} />
      </div>

      {/* Analyze CTA — visible on hover */}
      <div className="flex items-center gap-1 mt-2 text-[10px] font-semibold text-[hsl(var(--muted-foreground))] group-hover:text-[hsl(var(--primary))] transition-colors">
        Get full signal <ChevronRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
      </div>
    </button>
  );
}
