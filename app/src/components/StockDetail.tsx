import { useState } from 'react';
import { X, Trash2, ExternalLink, AlertTriangle, Info } from 'lucide-react';
import type { StockWithConviction, ScoreInputs } from '../types';
import { removeStock } from '../lib/storage';
import { getConvictionResult } from '../lib/convictionEngine';
import { formatPositionValue, formatShares, formatAvgCost } from '../lib/portfolioCalc';
import { getWarnings } from '../lib/warnings';
import { cn } from '../lib/utils';

// URL helpers
const getYahooFinanceUrl = (ticker: string) => `https://finance.yahoo.com/quote/${ticker}/`;

interface StockDetailProps {
  stock: StockWithConviction;
  onClose: () => void;
  onUpdate: () => void;
}

export function StockDetail({ stock, onClose, onUpdate }: StockDetailProps) {
  const [isDeleting, setIsDeleting] = useState(false);

  // Calculate conviction - fully automated, no manual input
  const inputs: ScoreInputs = {
    qualityScore: stock.qualityScore ?? 50,
    momentumScore: stock.momentumScore ?? 50,
    earningsScore: stock.earningsScore ?? 50,
    analystScore: stock.analystScore ?? 50,
  };
  // Determine if fundamental metrics data is available
  const hasMetricsData = (stock.peRatio !== null && stock.peRatio !== undefined) || (stock.eps !== null && stock.eps !== undefined);
  
  // Debug logging
  console.log(`[StockDetail] ${stock.ticker}: eps=${stock.eps}, peRatio=${stock.peRatio}, hasMetricsData=${hasMetricsData}`);
  
  const conviction = getConvictionResult(inputs, hasMetricsData);

  // Posture styling
  const postureConfig = {
    Buy: { bg: 'bg-green-50', text: 'text-green-700' },
    Hold: { bg: 'bg-amber-50', text: 'text-amber-700' },
    Sell: { bg: 'bg-red-50', text: 'text-red-700' },
  };
  const posture = postureConfig[conviction.posture];

  // Delete stock
  const handleDelete = () => {
    if (confirm(`Remove ${stock.ticker} from your portfolio?`)) {
      setIsDeleting(true);
      removeStock(stock.ticker);
      onUpdate();
      onClose();
    }
  };

  // Calculate position value for display
  const positionValue = stock.shares && stock.avgCost ? stock.shares * stock.avgCost : undefined;

  // Get warnings for this stock
  const warnings = getWarnings({
    ticker: stock.ticker,
    portfolioWeight: stock.portfolioWeight,
    avgCost: stock.avgCost,
    currentPrice: stock.currentPrice,
  });

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />

      {/* Slide-over Panel */}
      <div className="fixed inset-y-0 right-0 w-full max-w-lg bg-white shadow-xl z-50 overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-[hsl(var(--border))] px-6 py-4 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-[hsl(var(--foreground))]">
                {stock.ticker}
              </h2>
              <a
                href={getYahooFinanceUrl(stock.ticker)}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1.5 rounded-md hover:bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))] transition-colors"
                title="View on Yahoo Finance"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">{stock.name}</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-[hsl(var(--secondary))] rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Posture + Score */}
          <div className={cn('p-4 rounded-lg', posture.bg)}>
            <div className="flex items-center justify-between mb-2">
              <span className={cn('text-lg font-semibold', posture.text)}>
                {conviction.posture} ({conviction.confidence})
              </span>
              <span className="text-2xl font-bold text-[hsl(var(--foreground))]">
                {conviction.score}/100
              </span>
            </div>
            <p className="text-sm text-[hsl(var(--muted-foreground))] italic">
              Score is 100% data-driven from Finnhub
            </p>
          </div>

          {/* Current Price */}
          {stock.currentPrice && (
            <div className="flex items-center justify-between p-4 bg-[hsl(var(--secondary))] rounded-lg">
              <span className="text-sm text-[hsl(var(--muted-foreground))]">Current Price</span>
              <span className="text-lg font-semibold">${stock.currentPrice.toFixed(2)}</span>
            </div>
          )}

          {/* Position Data (if available) */}
          {(stock.shares || stock.avgCost) && (
            <div className="grid grid-cols-3 gap-4 p-4 bg-[hsl(var(--secondary))] rounded-lg">
              <div>
                <p className="text-xs text-[hsl(var(--muted-foreground))]">Shares</p>
                <p className="font-medium">{formatShares(stock.shares)}</p>
              </div>
              <div>
                <p className="text-xs text-[hsl(var(--muted-foreground))]">Avg Cost</p>
                <p className="font-medium">{formatAvgCost(stock.avgCost)}</p>
              </div>
              <div>
                <p className="text-xs text-[hsl(var(--muted-foreground))]">Cost Basis</p>
                <p className="font-medium">{formatPositionValue(positionValue)}</p>
              </div>
            </div>
          )}

          {/* Risk Warnings */}
          {warnings.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-[hsl(var(--foreground))] flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500" />
                Risk Alerts
              </h3>
              {warnings.map((warning, i) => (
                <div
                  key={i}
                  className={cn(
                    'p-3 rounded-lg border text-sm',
                    warning.severity === 'critical' && 'bg-red-50 border-red-200',
                    warning.severity === 'warning' && 'bg-amber-50 border-amber-200',
                    warning.severity === 'info' && 'bg-blue-50 border-blue-200'
                  )}
                >
                  <p
                    className={cn(
                      'font-medium',
                      warning.severity === 'critical' && 'text-red-700',
                      warning.severity === 'warning' && 'text-amber-700',
                      warning.severity === 'info' && 'text-blue-700'
                    )}
                  >
                    {warning.message}
                  </p>
                  {warning.action && (
                    <p className="text-[hsl(var(--muted-foreground))] mt-1">{warning.action}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Key Fundamentals */}
          <div>
            <h3 className="text-sm font-medium text-[hsl(var(--foreground))] mb-3">
              📊 Key Fundamentals
            </h3>
            {(stock.peRatio !== null && stock.peRatio !== undefined) || (stock.eps !== null && stock.eps !== undefined) ? (
              <div className="grid grid-cols-2 gap-3">
                {stock.eps !== null && stock.eps !== undefined && (
                  <div className="p-3 bg-[hsl(var(--secondary))] rounded-lg">
                    <p className="text-xs text-[hsl(var(--muted-foreground))]">EPS (TTM)</p>
                    <p className={cn("font-semibold", stock.eps < 0 ? "text-red-600" : "text-green-600")}>
                      ${stock.eps.toFixed(2)}
                    </p>
                  </div>
                )}
                {stock.peRatio !== null && stock.peRatio !== undefined && (
                  <div className="p-3 bg-[hsl(var(--secondary))] rounded-lg">
                    <p className="text-xs text-[hsl(var(--muted-foreground))]">P/E Ratio</p>
                    <p className="font-semibold">
                      {stock.peRatio < 0 ? 'N/A' : stock.peRatio.toFixed(1)}
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm">
                <p className="text-amber-800">
                  <span className="font-medium">⚠️ Limited fundamental data available</span>
                </p>
                <p className="text-amber-700 text-xs mt-1">
                  Finnhub free tier may not have full metrics for {stock.ticker}. Check EPS history below and Yahoo Finance for detailed fundamentals.
                </p>
              </div>
            )}
          </div>

          {/* Score Breakdown */}
          <div>
            <h3 className="text-sm font-medium text-[hsl(var(--foreground))] mb-3">
              Score Breakdown (Automated)
            </h3>
            <div className="space-y-3">
              <ScoreBar
                label="Quality (Profitability)"
                value={stock.qualityScore ?? 50}
                tooltip="Based on EPS, profit margin, operating margin, ROE, and P/E ratio. Penalizes unprofitable companies."
              />
              <ScoreBar
                label="Earnings (EPS History)"
                value={stock.earningsScore ?? 50}
                tooltip="Based on revenue growth, EPS growth, and earnings beat/miss history over last 4 quarters."
              />
              <ScoreBar
                label="Analyst Consensus"
                value={stock.analystScore ?? 50}
                tooltip="Weighted average of Wall Street ratings: Strong Buy (5) → Strong Sell (1), converted to 0-100 scale."
              />
              <ScoreBar
                label="Momentum (Price)"
                value={stock.momentumScore ?? 50}
                tooltip="Position in 52-week range, daily price change, and beta (volatility). Higher = near highs, lower = near lows."
              />
            </div>
          </div>

          {/* Rationale */}
          <div>
            <h3 className="text-sm font-medium text-[hsl(var(--foreground))] mb-2">Rationale</h3>
            <ul className="space-y-1">
              {conviction.rationale.length > 0 ? (
                conviction.rationale.map((bullet, i) => (
                  <li
                    key={i}
                    className="text-sm text-[hsl(var(--muted-foreground))] flex items-start gap-2"
                  >
                    <span className="text-[hsl(var(--primary))]">•</span>
                    {bullet}
                  </li>
                ))
              ) : (
                <li className="text-sm text-[hsl(var(--muted-foreground))] italic">
                  Refresh to get data signals
                </li>
              )}
            </ul>
          </div>

          {/* Analyst Consensus */}
          {stock.analystRating && (
            <div>
              <h3 className="text-sm font-medium text-[hsl(var(--foreground))] mb-3">
                📊 Wall Street Consensus
              </h3>
              <div className="p-4 bg-[hsl(var(--secondary))] rounded-lg">
                {/* Rating badge */}
                <div className="flex items-center justify-between mb-3">
                  <span
                    className={cn(
                      'px-3 py-1 rounded-full text-sm font-semibold',
                      stock.analystRating.rating.includes('Buy') && 'bg-green-100 text-green-700',
                      stock.analystRating.rating === 'Hold' && 'bg-amber-100 text-amber-700',
                      stock.analystRating.rating.includes('Sell') && 'bg-red-100 text-red-700'
                    )}
                  >
                    {stock.analystRating.rating}
                  </span>
                  {stock.analystRating.targetMean > 0 && (
                    <span className="text-sm text-[hsl(var(--muted-foreground))]">
                      Target: ${stock.analystRating.targetMean.toFixed(0)}
                    </span>
                  )}
                </div>

                {/* Breakdown bar */}
                {(stock.analystRating.strongBuy > 0 ||
                  stock.analystRating.buy > 0 ||
                  stock.analystRating.hold > 0 ||
                  stock.analystRating.sell > 0 ||
                  stock.analystRating.strongSell > 0) && (
                  <>
                    <div className="flex h-3 rounded-full overflow-hidden mb-2">
                      {stock.analystRating.strongBuy > 0 && (
                        <div
                          className="bg-green-600"
                          style={{
                            width: `${(stock.analystRating.strongBuy / (stock.analystRating.strongBuy + stock.analystRating.buy + stock.analystRating.hold + stock.analystRating.sell + stock.analystRating.strongSell)) * 100}%`,
                          }}
                        />
                      )}
                      {stock.analystRating.buy > 0 && (
                        <div
                          className="bg-green-400"
                          style={{
                            width: `${(stock.analystRating.buy / (stock.analystRating.strongBuy + stock.analystRating.buy + stock.analystRating.hold + stock.analystRating.sell + stock.analystRating.strongSell)) * 100}%`,
                          }}
                        />
                      )}
                      {stock.analystRating.hold > 0 && (
                        <div
                          className="bg-amber-400"
                          style={{
                            width: `${(stock.analystRating.hold / (stock.analystRating.strongBuy + stock.analystRating.buy + stock.analystRating.hold + stock.analystRating.sell + stock.analystRating.strongSell)) * 100}%`,
                          }}
                        />
                      )}
                      {stock.analystRating.sell > 0 && (
                        <div
                          className="bg-red-400"
                          style={{
                            width: `${(stock.analystRating.sell / (stock.analystRating.strongBuy + stock.analystRating.buy + stock.analystRating.hold + stock.analystRating.sell + stock.analystRating.strongSell)) * 100}%`,
                          }}
                        />
                      )}
                      {stock.analystRating.strongSell > 0 && (
                        <div
                          className="bg-red-600"
                          style={{
                            width: `${(stock.analystRating.strongSell / (stock.analystRating.strongBuy + stock.analystRating.buy + stock.analystRating.hold + stock.analystRating.sell + stock.analystRating.strongSell)) * 100}%`,
                          }}
                        />
                      )}
                    </div>
                    <div className="flex justify-between text-xs text-[hsl(var(--muted-foreground))]">
                      <span>🟢 {stock.analystRating.strongBuy + stock.analystRating.buy} Buy</span>
                      <span>🟡 {stock.analystRating.hold} Hold</span>
                      <span>
                        🔴 {stock.analystRating.sell + stock.analystRating.strongSell} Sell
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* EPS History */}
          {stock.quarterlyEPS && stock.quarterlyEPS.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-[hsl(var(--foreground))] mb-3">
                📈 EPS History
              </h3>
              <div className="space-y-2">
                {stock.quarterlyEPS.slice(0, 4).map((quarter, index) => {
                  const prevQuarter = stock.quarterlyEPS?.[index + 1];
                  let qoqChange: number | null = null;
                  if (prevQuarter && prevQuarter.eps !== 0) {
                    qoqChange = ((quarter.eps - prevQuarter.eps) / Math.abs(prevQuarter.eps)) * 100;
                  }

                  return (
                    <div
                      key={index}
                      className="flex items-center justify-between p-3 bg-[hsl(var(--secondary))] rounded-lg text-sm"
                    >
                      <span className="text-[hsl(var(--muted-foreground))]">
                        {quarter.date || quarter.period}
                      </span>
                      <div className="flex items-center gap-3">
                        <span className="font-medium">${quarter.eps.toFixed(2)}</span>
                        {qoqChange !== null && (
                          <span className={qoqChange >= 0 ? 'text-green-600' : 'text-red-600'}>
                            {qoqChange >= 0 ? '+' : ''}
                            {qoqChange.toFixed(1)}%
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Data source note */}
          <p className="text-xs text-[hsl(var(--muted-foreground))] italic text-center py-2">
            Score is 100% data-driven from Finnhub. Conviction reflects cumulative signals, not a price prediction.
          </p>

          {/* Delete */}
          <div className="pt-4 border-t border-[hsl(var(--border))]">
            <button
              onClick={handleDelete}
              disabled={isDeleting}
              className="flex items-center gap-2 text-sm text-red-600 hover:text-red-700"
            >
              <Trash2 className="w-4 h-4" />
              Remove from portfolio
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// Score bar component with info tooltip
function ScoreBar({
  label,
  value,
  tooltip,
}: {
  label: string;
  value: number;
  tooltip?: string;
}) {
  const [showTooltip, setShowTooltip] = useState(false);

  const getBarColor = (val: number) => {
    // Aligned with conviction engine thresholds (Buy=60, Sell=35)
    if (val >= 60) return 'bg-green-500';
    if (val >= 35) return 'bg-amber-500';
    return 'bg-red-500';
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-[hsl(var(--muted-foreground))]">{label}</span>
          {tooltip && (
            <div className="relative">
              <button
                onClick={() => setShowTooltip(!showTooltip)}
                onMouseEnter={() => setShowTooltip(true)}
                onMouseLeave={() => setShowTooltip(false)}
                className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))] transition-colors"
              >
                <Info className="w-3.5 h-3.5" />
              </button>
              {showTooltip && (
                <div className="absolute z-50 left-0 top-6 w-56 p-2.5 bg-[hsl(var(--popover))] text-[hsl(var(--popover-foreground))] text-xs rounded-lg shadow-lg border border-[hsl(var(--border))]">
                  {tooltip}
                </div>
              )}
            </div>
          )}
        </div>
        <span className="text-sm font-medium">{value}</span>
      </div>
      <div className="h-2 bg-[hsl(var(--secondary))] rounded-full overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', getBarColor(value))}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}
