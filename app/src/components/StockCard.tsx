import {
  ChevronRight,
  TrendingUp,
  TrendingDown,
  Minus,
  ExternalLink,
  AlertTriangle,
} from 'lucide-react';
import type { StockWithConviction } from '../types';
import { cn } from '../lib/utils';
import { getWarnings, getMostSevereWarning } from '../lib/warnings';

// Yahoo Finance URL helper
const getYahooFinanceUrl = (ticker: string) => `https://finance.yahoo.com/quote/${ticker}/`;

interface StockCardProps {
  stock: StockWithConviction;
  onClick: () => void;
}

export function StockCard({ stock, onClick }: StockCardProps) {
  const { conviction } = stock;

  // Get warnings for this stock
  const warnings = getWarnings({
    ticker: stock.ticker,
    portfolioWeight: stock.portfolioWeight,
    avgCost: stock.avgCost,
    currentPrice: stock.currentPrice,
  });
  const topWarning = getMostSevereWarning(warnings);

  // Posture color config
  const postureConfig = {
    Buy: {
      bg: 'bg-emerald-50',
      text: 'text-emerald-700',
      border: 'border-emerald-200',
      dot: 'bg-emerald-500',
    },
    Hold: {
      bg: 'bg-amber-50',
      text: 'text-amber-700',
      border: 'border-amber-200',
      dot: 'bg-amber-500',
    },
    Sell: {
      bg: 'bg-red-50',
      text: 'text-red-700',
      border: 'border-red-200',
      dot: 'bg-red-500',
    },
  };

  const posture = postureConfig[conviction.posture];

  // Delta indicator
  const delta =
    stock.previousScore !== undefined ? stock.conviction.score - stock.previousScore : 0;

  const DeltaIcon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
  const deltaColor = delta > 0 ? 'text-emerald-600' : delta < 0 ? 'text-red-600' : 'text-gray-400';

  return (
    <button
      onClick={onClick}
      className="card-hover w-full text-left bg-white rounded-2xl border border-[hsl(var(--border))] p-5 hover:border-[hsl(var(--primary))/50] shadow-sm group"
    >
      <div className="flex items-start justify-between gap-4">
        {/* Left: Stock Info */}
        <div className="flex-1 min-w-0">
          {/* Top Row: Ticker + Yahoo Link + Weight + Name */}
          <div className="flex items-center gap-3 mb-3">
            <span className="text-lg font-bold text-[hsl(var(--foreground))]">{stock.ticker}</span>

            {/* Yahoo Finance link */}
            <a
              href={getYahooFinanceUrl(stock.ticker)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="p-1 rounded-md hover:bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))] transition-colors"
              title="View on Yahoo Finance"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>

            {/* Portfolio weight badge */}
            {stock.portfolioWeight !== undefined && (
              <span className="text-xs font-semibold px-2 py-1 bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))] rounded-lg">
                {stock.portfolioWeight}%
              </span>
            )}

            <span className="text-sm text-[hsl(var(--muted-foreground))] truncate">
              {stock.name}
            </span>
          </div>

          {/* Middle Row: Posture Badge + Buy Priority + Score + Delta */}
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            {stock.isLoading ? (
              /* Loading skeleton */
              <>
                <div className="h-8 w-32 bg-gray-200 animate-pulse rounded-full" />
                <div className="h-8 w-20 bg-gray-200 animate-pulse rounded" />
              </>
            ) : (
              <>
                {/* Posture Pill - with confidence intensity */}
                <span
                  className={cn(
                    'inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-semibold border',
                    posture.bg,
                    posture.text,
                    posture.border,
                    // High confidence = ring highlight
                    conviction.confidence === 'High' && 'ring-2 ring-offset-1',
                    conviction.confidence === 'High' &&
                      conviction.posture === 'Buy' &&
                      'ring-emerald-400',
                    conviction.confidence === 'High' &&
                      conviction.posture === 'Hold' &&
                      'ring-amber-400',
                    conviction.confidence === 'High' &&
                      conviction.posture === 'Sell' &&
                      'ring-red-400',
                    // Low confidence = dashed border
                    conviction.confidence === 'Low' && 'border-dashed'
                  )}
                >
                  <span className={cn('w-2 h-2 rounded-full', posture.dot)} />
                  {conviction.posture}
                  <span
                    className={cn('font-normal', conviction.confidence === 'High' && 'font-medium')}
                  >
                    ({conviction.confidence})
                  </span>
                </span>

                {/* Trade Signal Badge - Only show BUY or SELL */}
                {stock.buyPriority && (
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-bold border',
                      stock.buyPriority === 'BUY' &&
                        'bg-green-100 text-green-800 border-green-300 shadow-sm',
                      stock.buyPriority === 'SELL' && 'bg-red-100 text-red-700 border-red-300',
                      // Add subtle dashed border if missing position data
                      !stock.shares && 'border-dashed opacity-75'
                    )}
                    title={
                      !stock.shares
                        ? 'Limited data - add position info for accurate signals'
                        : stock.buyPriority === 'BUY'
                          ? 'Strong opportunity - deploy capital'
                          : 'Trim position - reduce risk'
                    }
                  >
                    {stock.buyPriority === 'BUY' && '🎯 BUY'}
                    {stock.buyPriority === 'SELL' && '🔻 SELL'}
                    {!stock.shares && <span className="text-[0.6rem]">*</span>}
                  </span>
                )}

                {/* Score */}
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-bold text-[hsl(var(--foreground))]">
                    {conviction.score}
                  </span>
                  <span className="text-sm text-[hsl(var(--muted-foreground))]">/100</span>
                </div>

                {/* Delta */}
                {delta !== 0 && (
                  <span className={cn('flex items-center gap-1 text-sm font-medium', deltaColor)}>
                    <DeltaIcon className="w-4 h-4" />
                    {delta > 0 ? `+${delta}` : delta}
                  </span>
                )}

                {/* Data Age (if > 5 minutes) */}
                {stock.lastDataFetch &&
                  (() => {
                    const ageMs = Date.now() - new Date(stock.lastDataFetch).getTime();
                    const ageMinutes = Math.round(ageMs / (1000 * 60));
                    return ageMinutes >= 5 ? (
                      <span className="text-xs text-[hsl(var(--muted-foreground))] opacity-60">
                        {ageMinutes < 60 ? `${ageMinutes}m` : `${Math.round(ageMinutes / 60)}h`}
                      </span>
                    ) : null;
                  })()}
              </>
            )}

            {/* Warning Badge */}
            {!stock.isLoading && topWarning && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium border',
                  topWarning.severity === 'critical' && 'bg-red-100 text-red-700 border-red-200',
                  topWarning.severity === 'warning' &&
                    'bg-amber-100 text-amber-700 border-amber-200',
                  topWarning.severity === 'info' && 'bg-blue-100 text-blue-700 border-blue-200'
                )}
                title={topWarning.action}
              >
                <AlertTriangle className="w-3 h-3" />
                {topWarning.type === 'loss' && 'Loss'}
                {topWarning.type === 'concentration' && 'Concentrated'}
                {topWarning.type === 'gain' && 'Gain'}
                {topWarning.type === 'rebalance' && 'Rebalance'}
              </span>
            )}
          </div>

          {/* Bottom Row: Rationale */}
          <div className="space-y-1">
            {stock.isLoading ? (
              <>
                <div className="h-4 bg-gray-200 animate-pulse rounded w-3/4" />
                <div className="h-3 bg-gray-200 animate-pulse rounded w-1/4" />
              </>
            ) : (
              <>
                <p className="text-sm text-[hsl(var(--muted-foreground))] leading-relaxed">
                  {stock.buyPriorityReasoning ||
                    conviction.rationale[0] ||
                    'Click refresh to fetch market data'}
                </p>

                {/* Current price with change */}
                {stock.currentPrice && (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-[hsl(var(--muted-foreground))] opacity-75">
                      ${stock.currentPrice.toFixed(2)}
                    </span>
                    {stock.priceChange !== undefined &&
                      stock.priceChangePercent !== undefined &&
                      stock.priceChange !== null &&
                      stock.priceChangePercent !== null && (
                        <span
                          className={cn(
                            'font-medium',
                            stock.priceChange > 0 && 'text-green-600',
                            stock.priceChange < 0 && 'text-red-600',
                            stock.priceChange === 0 && 'text-gray-500'
                          )}
                        >
                          {stock.priceChange >= 0 ? '+' : '-'}$
                          {Math.abs(stock.priceChange).toFixed(2)} (
                          {stock.priceChange >= 0 ? '+' : ''}
                          {stock.priceChangePercent.toFixed(2)}%)
                        </span>
                      )}
                  </div>
                )}

                {/* News/Events Section */}
                {stock.recentNews && stock.recentNews.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-gray-200">
                    <div className="flex items-start gap-1.5 text-xs">
                      <span className="text-blue-600 mt-0.5">📰</span>
                      <div className="flex-1">
                        <p className="text-[hsl(var(--muted-foreground))] line-clamp-2">
                          {stock.recentNews[0].headline}
                        </p>
                        <span className="text-[hsl(var(--muted-foreground))] opacity-60 text-[10px]">
                          {(() => {
                            const hoursAgo = Math.round(
                              (Date.now() - stock.recentNews[0].datetime * 1000) / (1000 * 60 * 60)
                            );
                            return hoursAgo < 24
                              ? `${hoursAgo}h ago`
                              : `${Math.round(hoursAgo / 24)}d ago`;
                          })()}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Right: Chevron */}
        <div className="flex-shrink-0 p-2 rounded-xl bg-[hsl(var(--secondary))] group-hover:bg-[hsl(var(--primary))] group-hover:text-white transition-colors">
          <ChevronRight className="w-5 h-5" />
        </div>
      </div>
    </button>
  );
}
