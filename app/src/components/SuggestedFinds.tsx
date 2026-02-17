import { useState, useEffect, useRef } from 'react';
import {
  TrendingUp,
  Gem,
  ChevronDown,
  ChevronUp,
  Sparkles,
  RefreshCw,
  AlertCircle,
  Award,
  Zap,
  CheckCircle2,
} from 'lucide-react';
import { TickerLabel } from './TickerLabel';
import { ErrorBanner } from './ErrorBanner';
import type { EnhancedSuggestedStock } from '../data/suggestedFinds';
import { useSuggestedFinds, COMPOUNDER_CATEGORIES, GOLD_MINE_CATEGORIES } from '../hooks/useSuggestedFinds';
import { cn } from '../lib/utils';
import { getAutoTraderConfig, processSuggestedFinds, type ProcessResult } from '../lib/autoTrader';
import { getActiveTrades } from '../lib/paperTradesApi';
import { useAuth } from '../lib/auth';

interface SuggestedFindsProps {
  existingTickers: string[];
}

export function SuggestedFinds({ existingTickers }: SuggestedFindsProps) {
  const {
    compounders,
    displayedCompounders,
    goldMines,
    displayedGoldMines,
    currentTheme,
    isLoading,
    error,
    lastUpdated,
    step,
    stepLabel,
    refresh,
    selectedCategory,
    setSelectedCategory,
    isCategoryLoading,
    categoryStep,
    categoryStepLabel,
    categoryError,
    discoverCategory,
    selectedGoldMineCategory,
    setSelectedGoldMineCategory,
    isGoldMineCategoryLoading,
    goldMineCategoryStep,
    goldMineCategoryStepLabel,
    goldMineCategoryError,
    discoverGoldMineCategory,
  } = useSuggestedFinds(existingTickers);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [, setAutoTradeResults] = useState<ProcessResult[]>([]);
  const [isAutoTrading, setIsAutoTrading] = useState(false);
  const [ownedTickers, setOwnedTickers] = useState<Set<string>>(new Set());
  const processedFindsRef = useRef<Set<string>>(new Set());
  const [catAutoTradeOffer, setCatAutoTradeOffer] = useState<'idle' | 'offered' | 'trading' | 'done'>('idle');
  const [catAutoTradeResults, setCatAutoTradeResults] = useState<ProcessResult[]>([]);
  const catAutoTradedRef = useRef<Set<string>>(new Set());
  const { user } = useAuth();
  const isAuthed = !!user;

  // Fetch active trades to mark owned stocks
  useEffect(() => {
    if (!isAuthed) return;
    getActiveTrades()
      .then(trades => setOwnedTickers(new Set(trades.map(t => t.ticker))))
      .catch(() => {/* ignore — badge is best-effort */});
  }, [isAuthed, isAutoTrading]); // re-fetch after auto-trading finishes

  // ── Auto-buy Suggested Finds ──
  useEffect(() => {
    const config = getAutoTraderConfig();
    if (!config.enabled || !isAuthed) return;

    // Combine compounders and gold mines
    const allStocks = [...displayedCompounders, ...displayedGoldMines];
    if (allStocks.length === 0) return;

    // Identify top picks (first in each list with conviction 8+)
    const topPickTickers = new Set<string>();
    const firstCompounder = displayedCompounders[0];
    const firstGoldMine = displayedGoldMines[0];
    if (firstCompounder && (firstCompounder.conviction ?? 0) >= 8) topPickTickers.add(firstCompounder.ticker);
    if (firstGoldMine && (firstGoldMine.conviction ?? 0) >= 8) topPickTickers.add(firstGoldMine.ticker);

    // Filter: conviction >= minSuggestedFindsConviction AND Undervalued/Deep Value,
    // OR top pick (always buy regardless of valuation)
    const minConv = config.minSuggestedFindsConviction;
    const newStocks = allStocks.filter(s => {
      if (processedFindsRef.current.has(s.ticker)) return false;
      const conv = s.conviction ?? 0;
      // Always buy top picks
      if (topPickTickers.has(s.ticker) && conv >= minConv) return true;
      if (conv < minConv) return false;
      const tag = (s.valuationTag ?? '').toLowerCase();
      return tag === 'deep value' || tag === 'undervalued';
    });
    if (newStocks.length === 0) return;

    // Mark as processed to avoid duplicates
    newStocks.forEach(s => processedFindsRef.current.add(s.ticker));

    setIsAutoTrading(true);
    processSuggestedFinds(newStocks, config, topPickTickers)
      .then(results => {
        setAutoTradeResults(results);
        setIsAutoTrading(false);
      })
      .catch(() => setIsAutoTrading(false));
  }, [displayedCompounders, displayedGoldMines, isAuthed]);

  // Show auto-trade offer when Gold Mine category results load
  useEffect(() => {
    if (!selectedGoldMineCategory || isGoldMineCategoryLoading) return;
    if (displayedGoldMines.length === 0) return;
    const config = getAutoTraderConfig();
    if (!config.enabled || !isAuthed) return;
    // Only offer if we haven't already for this category
    if (catAutoTradedRef.current.has(selectedGoldMineCategory)) return;
    setCatAutoTradeOffer('offered');
    setCatAutoTradeResults([]);
  }, [selectedGoldMineCategory, displayedGoldMines, isGoldMineCategoryLoading, isAuthed]);

  const handleCategoryAutoTrade = async () => {
    if (!selectedGoldMineCategory) return;
    setCatAutoTradeOffer('trading');
    catAutoTradedRef.current.add(selectedGoldMineCategory);
    try {
      const config = getAutoTraderConfig();
      const topPick = displayedGoldMines[0];
      const topPickTickers = new Set<string>();
      if (topPick && (topPick.conviction ?? 0) >= 8) topPickTickers.add(topPick.ticker);
      const results = await processSuggestedFinds(displayedGoldMines, config, topPickTickers);
      setCatAutoTradeResults(results);
      setCatAutoTradeOffer('done');
      // Refresh owned tickers
      getActiveTrades().then(trades => setOwnedTickers(new Set(trades.map(t => t.ticker)))).catch(() => {});
    } catch {
      setCatAutoTradeOffer('done');
    }
  };

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

      {/* Auto-trading indicator */}
      {isAuthed && getAutoTraderConfig().enabled && (
        <div className={cn(
          'flex items-center gap-2 px-3 py-2 rounded-lg text-sm',
          isAutoTrading
            ? 'bg-amber-50 text-amber-700 border border-amber-200'
            : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
        )}>
          <Zap className={cn('w-3.5 h-3.5', isAutoTrading && 'animate-pulse')} />
          {isAutoTrading
            ? 'Auto-buying qualifying suggested finds...'
            : `Auto-buy enabled — conviction ${getAutoTraderConfig().minSuggestedFindsConviction}+ Undervalued/Deep Value + all Top Picks`
          }
        </div>
      )}

      {/* Steady Compounders */}
      <section>
        <div className="flex items-center gap-3 mb-3">
          <div className="p-2 rounded-lg bg-blue-50">
            <TrendingUp className="w-4 h-4 text-blue-600" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-[hsl(var(--foreground))]">Steady Compounders</h3>
            </div>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              AI-proof businesses in boring industries — built to compound, not to hype
            </p>
          </div>
        </div>

        {/* Category dropdown */}
        <div className="mb-4">
          <select
            value={selectedCategory ?? ''}
            onChange={(e) => setSelectedCategory(e.target.value || null)}
            className="text-sm px-3 py-1.5 rounded-lg border border-[hsl(var(--border))] bg-white text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-blue-200 transition-colors"
          >
            <option value="">All Industries</option>
            {COMPOUNDER_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
        </div>

        {isLoading && compounders.length === 0 ? (
          <SkeletonCards count={3} />
        ) : isCategoryLoading ? (
          <CategoryLoadingState stepLabel={categoryStepLabel} step={categoryStep} />
        ) : categoryError && selectedCategory ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <div className="p-2.5 rounded-full bg-red-50 mb-3">
              <AlertCircle className="w-5 h-5 text-red-500" />
            </div>
            <p className="text-sm text-[hsl(var(--muted-foreground))] mb-3">{categoryError}</p>
            <button
              onClick={() => discoverCategory(selectedCategory)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors text-sm font-medium"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Retry
            </button>
          </div>
        ) : displayedCompounders.length === 0 && selectedCategory ? (
          <CategoryEmptyState
            category={selectedCategory}
            onDiscover={() => discoverCategory(selectedCategory)}
          />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {displayedCompounders.map((stock, idx) => (
                <StockCard
                  key={stock.ticker}
                  stock={stock}
                  accentColor="blue"
                  isTopPick={idx === 0 && (stock.conviction ?? 0) >= 8}
                  isOwned={ownedTickers.has(stock.ticker)}
                />
              ))}
            </div>
            {/* Show "Find more" when filtered results are sparse */}
            {selectedCategory && displayedCompounders.length <= 2 && displayedCompounders.length > 0 && (
              <button
                onClick={() => discoverCategory(selectedCategory)}
                className="mt-4 inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 font-medium transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5" />
                Discover more {selectedCategory} stocks
              </button>
            )}
          </>
        )}
      </section>

      {/* Gold Mines */}
      <section>
        <div className="flex items-center gap-3 mb-3">
          <div className="p-2 rounded-lg bg-amber-50">
            <Gem className="w-4 h-4 text-amber-600" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-[hsl(var(--foreground))]">Gold Mines</h3>
            </div>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              High-conviction picks across all sectors
            </p>
          </div>
        </div>

        {/* Category dropdown */}
        <div className="mb-4">
          <select
            value={selectedGoldMineCategory ?? ''}
            onChange={(e) => setSelectedGoldMineCategory(e.target.value || null)}
            className="text-sm px-3 py-1.5 rounded-lg border border-[hsl(var(--border))] bg-white text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-amber-200 transition-colors"
          >
            <option value="">Today&apos;s Theme</option>
            {GOLD_MINE_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
        </div>

        {/* Dynamic theme context — only in Auto/Theme mode */}
        {!selectedGoldMineCategory && currentTheme && (
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
        ) : isGoldMineCategoryLoading ? (
          <CategoryLoadingState stepLabel={goldMineCategoryStepLabel} step={goldMineCategoryStep} accentColor="amber" />
        ) : goldMineCategoryError && selectedGoldMineCategory ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <div className="p-2.5 rounded-full bg-red-50 mb-3">
              <AlertCircle className="w-5 h-5 text-red-500" />
            </div>
            <p className="text-sm text-[hsl(var(--muted-foreground))] mb-3">{goldMineCategoryError}</p>
            <button
              onClick={() => discoverGoldMineCategory(selectedGoldMineCategory)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-600 text-white hover:bg-amber-700 transition-colors text-sm font-medium"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Retry
            </button>
          </div>
        ) : displayedGoldMines.length === 0 && selectedGoldMineCategory ? (
          <CategoryEmptyState
            category={selectedGoldMineCategory}
            onDiscover={() => discoverGoldMineCategory(selectedGoldMineCategory)}
            accentColor="amber"
          />
        ) : (
          <>
            {/* Auto-trade prompt — shown at top before cards so it's immediately visible */}
            {selectedGoldMineCategory && catAutoTradeOffer === 'offered' && (
              <div className="mb-4 flex items-center gap-3 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3">
                <Zap className="w-4 h-4 text-amber-600 flex-shrink-0" />
                <p className="text-sm text-amber-800 flex-1">
                  Auto-trade qualifying <span className="font-semibold">{selectedGoldMineCategory}</span> picks? Only conviction 8+ and undervalued stocks will be bought.
                </p>
                <button
                  onClick={handleCategoryAutoTrade}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-600 text-white hover:bg-amber-700 transition-colors"
                >
                  Auto-Trade
                </button>
                <button
                  onClick={() => { setCatAutoTradeOffer('idle'); catAutoTradedRef.current.add(selectedGoldMineCategory); }}
                  className="text-xs text-amber-600 hover:text-amber-800 font-medium"
                >
                  Dismiss
                </button>
              </div>
            )}
            {catAutoTradeOffer === 'trading' && (
              <div className="mb-4 flex items-center gap-2 text-sm text-amber-700">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                Auto-trading qualifying picks...
              </div>
            )}
            {catAutoTradeOffer === 'done' && catAutoTradeResults.length > 0 && (
              <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
                {catAutoTradeResults.map(r => (
                  <span key={r.ticker} className={cn(
                    'inline-flex items-center gap-1 px-2 py-1 rounded-full border font-medium',
                    r.action === 'executed' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-slate-50 border-slate-200 text-slate-600'
                  )}>
                    {r.action === 'executed' && <CheckCircle2 className="w-3 h-3" />}
                    {r.ticker}: {r.action === 'executed' ? 'Bought' : r.reason ?? 'Skipped'}
                  </span>
                ))}
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {displayedGoldMines.map((stock, idx) => (
                <StockCard
                  key={stock.ticker}
                  stock={stock}
                  accentColor="amber"
                  isTopPick={idx === 0 && (stock.conviction ?? 0) >= 8}
                  isOwned={ownedTickers.has(stock.ticker)}
                />
              ))}
            </div>
            {selectedGoldMineCategory && displayedGoldMines.length <= 2 && displayedGoldMines.length > 0 && (
              <button
                onClick={() => discoverGoldMineCategory(selectedGoldMineCategory)}
                className="mt-4 inline-flex items-center gap-1.5 text-sm text-amber-600 hover:text-amber-700 font-medium transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5" />
                Discover more {selectedGoldMineCategory} stocks
              </button>
            )}
          </>
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
// Loading skeleton cards
// ──────────────────────────────────────────────────────────

function SkeletonCards({ count }: { count: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
// Category loading + empty states
// ──────────────────────────────────────────────────────────

function CategoryLoadingState({ stepLabel, step, accentColor = 'blue' }: { stepLabel: string; step: string; accentColor?: 'blue' | 'amber' }) {
  const bg = accentColor === 'amber' ? 'bg-amber-50' : 'bg-blue-50';
  const iconColor = accentColor === 'amber' ? 'text-amber-500' : 'text-blue-500';
  const dotActive = accentColor === 'amber' ? 'bg-amber-500' : 'bg-blue-500';
  const dotDone = accentColor === 'amber' ? 'bg-amber-400' : 'bg-blue-400';

  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className={cn('p-3 rounded-full mb-3', bg)}>
        <Sparkles className={cn('w-6 h-6 animate-pulse', iconColor)} />
      </div>
      <p className="text-[hsl(var(--foreground))] font-medium mb-1">Discovering stocks...</p>
      {stepLabel && (
        <p className="text-sm text-[hsl(var(--muted-foreground))] animate-pulse">{stepLabel}</p>
      )}
      <div className="flex gap-1.5 mt-3">
        {(['finding_candidates', 'fetching_metrics', 'analyzing_compounders'] as const).map((s) => (
          <div
            key={s}
            className={cn(
              'w-2 h-2 rounded-full transition-colors duration-300',
              step === s
                ? cn(dotActive, 'animate-pulse')
                : ['finding_candidates', 'fetching_metrics', 'analyzing_compounders'].indexOf(s) <
                  ['finding_candidates', 'fetching_metrics', 'analyzing_compounders'].indexOf(step as typeof s)
                  ? dotDone
                  : 'bg-[hsl(var(--secondary))]'
            )}
          />
        ))}
      </div>
    </div>
  );
}

function CategoryEmptyState({ category, onDiscover, accentColor = 'blue' }: { category: string; onDiscover: () => void; accentColor?: 'blue' | 'amber' }) {
  const btnBg = accentColor === 'amber' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-blue-600 hover:bg-blue-700';

  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <p className="text-[hsl(var(--muted-foreground))] mb-3">
        No stocks found in <span className="font-medium text-[hsl(var(--foreground))]">{category}</span> from the current batch.
      </p>
      <button
        onClick={onDiscover}
        className={cn('inline-flex items-center gap-2 px-4 py-2 rounded-lg text-white transition-colors text-sm font-medium', btnBg)}
      >
        <Sparkles className="w-4 h-4" />
        Discover {category} Stocks
      </button>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Conviction badge (reusable)
// ──────────────────────────────────────────────────────────

function ConvictionBadge({ score }: { score: number }) {
  const bg = score >= 7 ? 'bg-emerald-100 text-emerald-700' : score >= 4 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700';
  return (
    <span className={cn('inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold', bg)}>
      {score}
    </span>
  );
}

// ──────────────────────────────────────────────────────────
// Valuation pills (reusable)
// ──────────────────────────────────────────────────────────

function ValuationPill({ tag }: { tag: string }) {
  const style =
    tag === 'Deep Value' || tag === 'Undervalued'
      ? 'bg-emerald-50 text-emerald-700'
      : tag === 'Fair Value'
        ? 'bg-gray-100 text-gray-600'
        : 'bg-orange-50 text-orange-700';
  return (
    <span className={cn('text-[10px] px-2 py-0.5 rounded-full font-medium', style)}>
      {tag}
    </span>
  );
}

// ──────────────────────────────────────────────────────────
// Stock card — clean card layout with conviction + badges
// ──────────────────────────────────────────────────────────

interface StockCardProps {
  stock: EnhancedSuggestedStock;
  accentColor: 'blue' | 'amber';
  isTopPick?: boolean;
  isOwned?: boolean;
}

function StockCard({ stock, accentColor, isTopPick, isOwned }: StockCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const borderHover = accentColor === 'blue' ? 'hover:border-blue-200' : 'hover:border-amber-200';
  const bulletColor = accentColor === 'blue' ? 'bg-blue-500' : 'bg-amber-500';
  const tagBg = accentColor === 'blue' ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700';

  return (
    <div
      className={cn(
        'bg-white rounded-2xl border border-[hsl(var(--border))] p-5 transition-all shadow-sm relative',
        borderHover,
        isExpanded && 'shadow-md',
        isTopPick && 'ring-2 ring-emerald-200 border-emerald-200'
      )}
    >
      {/* Top Pick label */}
      {isTopPick && (
        <div className="absolute -top-2.5 left-4 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500 text-white text-[10px] font-semibold shadow-sm">
          <Award className="w-3 h-3" />
          Top Pick
        </div>
      )}

      {/* Owned badge */}
      {isOwned && (
        <div className={cn(
          'absolute -top-2.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500 text-white text-[10px] font-semibold shadow-sm',
          isTopPick ? 'left-[5.5rem]' : 'left-4'
        )}>
          <CheckCircle2 className="w-3 h-3" />
          Owned
        </div>
      )}

      {/* Header: Ticker + Name + Conviction */}
      <div className="flex items-start justify-between mb-2">
        <TickerLabel ticker={stock.ticker} name={stock.name} />
        {stock.conviction != null && (
          <ConvictionBadge score={stock.conviction} />
        )}
      </div>

      {/* Category badge */}
      {stock.category && (
        <span className={cn('inline-block text-[10px] px-2 py-0.5 rounded-full font-medium mb-1.5', tagBg)}>
          {stock.category}
        </span>
      )}

      {/* Valuation pill */}
      {stock.valuationTag && (
        <div className="flex flex-wrap gap-1 mb-2">
          <ValuationPill tag={stock.valuationTag} />
        </div>
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
