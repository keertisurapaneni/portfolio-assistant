import { useState } from 'react';
import {
  TrendingUp,
  Gem,
  ChevronDown,
  ChevronUp,
  Sparkles,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';
import { TickerLabel } from './TickerLabel';
import { ErrorBanner } from './ErrorBanner';
import type { EnhancedSuggestedStock } from '../data/suggestedFinds';
import { useSuggestedFinds } from '../hooks/useSuggestedFinds';
import { cn } from '../lib/utils';

interface SuggestedFindsProps {
  existingTickers: string[];
}

export function SuggestedFinds({ existingTickers }: SuggestedFindsProps) {
  const {
    compounders,
    goldMines,
    currentTheme,
    isLoading,
    error,
    lastUpdated,
    step,
    stepLabel,
    refresh,
  } = useSuggestedFinds(existingTickers);

  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    refresh();
    setTimeout(() => setIsRefreshing(false), 1000);
  };

  const formatLastUpdated = (timestamp: string | null): string => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString();
  };

  // Loading state with step progress
  if (isLoading && compounders.length === 0 && goldMines.length === 0) {
    return (
      <div className="space-y-6">
        <Header
          lastUpdated={lastUpdated}
          formatLastUpdated={formatLastUpdated}
          isRefreshing={true}
          onRefresh={handleRefresh}
        />
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="p-4 rounded-full bg-violet-50 mb-4">
            <Sparkles className="w-8 h-8 text-violet-500 animate-pulse" />
          </div>
          <p className="text-[hsl(var(--foreground))] font-medium text-lg mb-2">
            Discovering stocks with AI
          </p>
          {stepLabel && (
            <p className="text-sm text-[hsl(var(--muted-foreground))] animate-pulse">
              {stepLabel}
            </p>
          )}
          <div className="flex gap-1.5 mt-4">
            {(['finding_candidates', 'fetching_metrics', 'analyzing_compounders', 'fetching_news', 'analyzing_themes'] as const).map(
              (s) => (
                <div
                  key={s}
                  className={cn(
                    'w-2 h-2 rounded-full transition-colors duration-300',
                    step === s
                      ? 'bg-violet-500 animate-pulse'
                      : ['finding_candidates', 'fetching_metrics', 'analyzing_compounders', 'fetching_news', 'analyzing_themes']
                          .indexOf(s) <
                        ['finding_candidates', 'fetching_metrics', 'analyzing_compounders', 'fetching_news', 'analyzing_themes']
                          .indexOf(step)
                        ? 'bg-violet-400'
                        : 'bg-[hsl(var(--secondary))]'
                  )}
                />
              )
            )}
          </div>
        </div>
      </div>
    );
  }

  // Empty state — no data, done loading
  if (!isLoading && compounders.length === 0 && goldMines.length === 0) {
    return (
      <div className="space-y-6">
        <Header
          lastUpdated={lastUpdated}
          formatLastUpdated={formatLastUpdated}
          isRefreshing={isRefreshing || isLoading}
          onRefresh={handleRefresh}
        />
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="p-4 rounded-full bg-[hsl(var(--secondary))] mb-4">
            <AlertCircle className="w-8 h-8 text-[hsl(var(--muted-foreground))]" />
          </div>
          <p className="text-[hsl(var(--muted-foreground))] text-lg mb-2">
            {error || 'AI suggestions are unavailable right now.'}
          </p>
          <button
            onClick={handleRefresh}
            className="mt-4 px-4 py-2 rounded-lg bg-[hsl(var(--primary))] text-white hover:opacity-90 transition-opacity flex items-center gap-2"
          >
            <RefreshCw className={cn('w-4 h-4', isRefreshing && 'animate-spin')} />
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <Header
        lastUpdated={lastUpdated}
        formatLastUpdated={formatLastUpdated}
        isRefreshing={isRefreshing || isLoading}
        onRefresh={handleRefresh}
      />

      {/* Quiet Compounders */}
      <section>
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-blue-50">
            <TrendingUp className="w-4 h-4 text-blue-600" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-[hsl(var(--foreground))]">Quiet Compounders</h3>
              <AIBadge />
            </div>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              Steady ROIC, low volatility, boring businesses that compound
            </p>
          </div>
        </div>
        {isLoading && compounders.length === 0 ? (
          <SkeletonCards count={3} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {compounders.map((stock) => (
              <StockCard
                key={stock.ticker}
                stock={stock}
                accentColor="blue"
              />
            ))}
          </div>
        )}
      </section>

      {/* Gold Mines */}
      <section>
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 rounded-lg bg-amber-50">
            <Gem className="w-4 h-4 text-amber-600" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-[hsl(var(--foreground))]">Gold Mines</h3>
              <AIBadge />
            </div>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              Theme-driven opportunities
            </p>
          </div>
        </div>

        {/* Dynamic theme context */}
        {currentTheme && (
          <div className="text-sm text-amber-700 bg-amber-50 px-4 py-2.5 rounded-lg mb-4 border border-amber-100">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="font-medium">Current theme:</span>
              <span>{currentTheme.name}</span>
              <Sparkles className="w-3 h-3 text-amber-500 ml-1" />
            </div>
            <span className="text-amber-600">{currentTheme.description}</span>
          </div>
        )}

        {isLoading && goldMines.length === 0 ? (
          <SkeletonCards count={3} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {goldMines.map((stock) => (
              <StockCard
                key={stock.ticker}
                stock={stock}
                accentColor="amber"
              />
            ))}
          </div>
        )}
      </section>

      {/* Error banner (non-fatal — showing cached data) */}
      {error && (compounders.length > 0 || goldMines.length > 0) && (
        <ErrorBanner message={error} variant="warning" />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Header with AI attribution and refresh
// ──────────────────────────────────────────────────────────

function Header({
  lastUpdated,
  formatLastUpdated,
  isRefreshing,
  onRefresh,
}: {
  lastUpdated: string | null;
  formatLastUpdated: (ts: string | null) => string;
  isRefreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-start justify-between">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-bold text-[hsl(var(--foreground))]">Suggested Finds</h2>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-50 text-violet-600 text-xs font-medium">
            <Sparkles className="w-3 h-3" />
            AI-powered
          </span>
        </div>
        <p className="text-[hsl(var(--muted-foreground))] mt-0.5">
          AI analysis grounded in real market data + news
          {lastUpdated && (
            <span className="text-[hsl(var(--muted-foreground))]/60">
              {' '}
              &middot; Updated {formatLastUpdated(lastUpdated)}
            </span>
          )}
        </p>
      </div>
      <button
        onClick={onRefresh}
        disabled={isRefreshing}
        className={cn(
          'p-2 rounded-lg transition-all',
          isRefreshing
            ? 'text-[hsl(var(--muted-foreground))]/40 cursor-not-allowed'
            : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))] hover:text-[hsl(var(--foreground))]'
        )}
        title="Get fresh AI suggestions"
      >
        <RefreshCw className={cn('w-5 h-5', isRefreshing && 'animate-spin')} />
      </button>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// AI-powered badge
// ──────────────────────────────────────────────────────────

function AIBadge() {
  return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-50 text-violet-500">
      <Sparkles className="w-2.5 h-2.5" />
      AI
    </span>
  );
}

// ──────────────────────────────────────────────────────────
// Loading skeleton cards
// ──────────────────────────────────────────────────────────

function SkeletonCards({ count }: { count: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="bg-white rounded-2xl border border-[hsl(var(--border))] p-5 space-y-3"
        >
          <div className="flex items-center gap-2">
            <div className="h-5 w-14 bg-[hsl(var(--secondary))] rounded animate-pulse" />
            <div className="h-4 w-24 bg-[hsl(var(--secondary))] rounded animate-pulse" />
          </div>
          <div className="h-3 w-full bg-[hsl(var(--secondary))] rounded animate-pulse" />
          <div className="h-3 w-2/3 bg-[hsl(var(--secondary))] rounded animate-pulse" />
          <div className="flex gap-2 pt-1">
            <div className="h-6 w-16 bg-[hsl(var(--secondary))] rounded-full animate-pulse" />
            <div className="h-6 w-20 bg-[hsl(var(--secondary))] rounded-full animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Stock card — clean card layout, no add button
// ──────────────────────────────────────────────────────────

interface StockCardProps {
  stock: EnhancedSuggestedStock;
  accentColor: 'blue' | 'amber';
}

function StockCard({ stock, accentColor }: StockCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const borderHover = accentColor === 'blue' ? 'hover:border-blue-200' : 'hover:border-amber-200';
  const bulletColor = accentColor === 'blue' ? 'bg-blue-500' : 'bg-amber-500';
  const tagBg = accentColor === 'blue' ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700';

  return (
    <div
      className={cn(
        'bg-white rounded-2xl border border-[hsl(var(--border))] p-5 transition-all shadow-sm',
        borderHover,
        isExpanded && 'shadow-md'
      )}
    >
      {/* Header: Ticker + Name + Yahoo link */}
      <div className="mb-2">
        <TickerLabel ticker={stock.ticker} name={stock.name} />
      </div>

      {/* Category badge for Gold Mines */}
      {stock.category && (
        <span className={cn('inline-block text-[10px] px-2 py-0.5 rounded-full font-medium mb-2', tagBg)}>
          {stock.category}
        </span>
      )}

      {/* Reason / one-liner */}
      <p className="text-sm text-[hsl(var(--muted-foreground))] leading-relaxed mb-3">
        {stock.reason}
      </p>

      {/* Metric pills — always visible */}
      {stock.metrics && stock.metrics.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {stock.metrics.slice(0, 3).map((metric) => (
            <span
              key={metric.label}
              className="text-[11px] px-2 py-0.5 bg-[hsl(var(--secondary))] rounded-full"
            >
              <span className="text-[hsl(var(--muted-foreground))]">{metric.label}:</span>{' '}
              <span className="font-semibold text-[hsl(var(--foreground))]">{metric.value}</span>
            </span>
          ))}
        </div>
      )}

      {/* Expand toggle */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] flex items-center gap-1 transition-colors"
      >
        {isExpanded ? (
          <>
            <ChevronUp className="w-3.5 h-3.5" />
            Less
          </>
        ) : (
          <>
            <ChevronDown className="w-3.5 h-3.5" />
            Why this stock?
          </>
        )}
      </button>

      {/* Expanded details */}
      {isExpanded && (
        <div className="mt-3 pt-3 border-t border-[hsl(var(--border))]">
          {/* Extra metrics if more than 3 */}
          {stock.metrics && stock.metrics.length > 3 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {stock.metrics.slice(3).map((metric) => (
                <span
                  key={metric.label}
                  className="text-[11px] px-2 py-0.5 bg-[hsl(var(--secondary))] rounded-full"
                >
                  <span className="text-[hsl(var(--muted-foreground))]">{metric.label}:</span>{' '}
                  <span className="font-semibold text-[hsl(var(--foreground))]">{metric.value}</span>
                </span>
              ))}
            </div>
          )}

          {/* Investment thesis points */}
          <ul className="space-y-1.5">
            {stock.whyGreat.map((point, index) => (
              <li key={index} className="flex items-start gap-2 text-sm">
                <span
                  className={cn('mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0', bulletColor)}
                />
                <span className="text-[hsl(var(--muted-foreground))]">{point}</span>
              </li>
            ))}
          </ul>

          {/* AI attribution */}
          <p className="text-[10px] text-[hsl(var(--muted-foreground))]/50 mt-3 flex items-center gap-1">
            <Sparkles className="w-2.5 h-2.5" />
            AI-generated insight — verify before investing
          </p>
        </div>
      )}
    </div>
  );
}
