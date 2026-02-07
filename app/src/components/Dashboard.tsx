import { useState } from 'react';
import { Plus, ArrowUpDown, BarChart3, Trash2, Shield } from 'lucide-react';
import type { StockWithConviction, RiskProfile } from '../types';
import { StockCard } from './StockCard';
import { cn } from '../lib/utils';

interface DashboardProps {
  stocks: StockWithConviction[];
  onStockSelect: (stock: StockWithConviction) => void;
  onAddTickers: () => void;
  onClearAll: () => void;
  riskProfile: RiskProfile;
  onRiskProfileChange: (profile: RiskProfile) => void;
}

type SortOption =
  | 'score-desc'
  | 'score-asc'
  | 'ticker'
  | 'recent'
  | 'weight'
  | 'change-pct'
  | 'change-dollar';

export function Dashboard({ stocks, onStockSelect, onAddTickers, onClearAll, riskProfile, onRiskProfileChange }: DashboardProps) {
  const [sortBy, setSortBy] = useState<SortOption>('score-desc');
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // Sort stocks based on selected option
  const sortedStocks = [...stocks].sort((a, b) => {
    switch (sortBy) {
      case 'score-desc':
        return b.conviction.score - a.conviction.score;
      case 'score-asc':
        return a.conviction.score - b.conviction.score;
      case 'ticker':
        return a.ticker.localeCompare(b.ticker);
      case 'recent':
        return new Date(b.dateAdded).getTime() - new Date(a.dateAdded).getTime();
      case 'weight':
        return (b.portfolioWeight ?? 0) - (a.portfolioWeight ?? 0);
      case 'change-pct':
        return (a.priceChangePercent ?? 0) - (b.priceChangePercent ?? 0);
      case 'change-dollar':
        return (a.priceChange ?? 0) - (b.priceChange ?? 0);
      default:
        return 0;
    }
  });

  const handleClearAll = () => {
    onClearAll();
    setShowClearConfirm(false);
  };

  // Empty state when no stocks
  if (stocks.length === 0) {
    return (
      <div className="text-center py-20">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[hsl(var(--secondary))] mb-6">
          <BarChart3 className="w-8 h-8 text-[hsl(var(--muted-foreground))]" />
        </div>
        <h3 className="text-xl font-semibold text-[hsl(var(--foreground))] mb-2">No stocks yet</h3>
        <p className="text-[hsl(var(--muted-foreground))] mb-8 max-w-sm mx-auto">
          Add your holdings to start tracking conviction and making clearer decisions
        </p>
        <button
          onClick={onAddTickers}
          className="inline-flex items-center gap-2 px-6 py-3 bg-[hsl(var(--primary))] text-white rounded-xl hover:bg-[hsl(221,83%,48%)] shadow-lg shadow-blue-500/20 font-medium transition-all"
        >
          <Plus className="w-5 h-5" />
          Add Your First Stocks
        </button>
      </div>
    );
  }

  // Calculate total portfolio value (only when shares data exists)
  const totalPortfolioValue = stocks.reduce((sum, s) => {
    if (s.shares && s.shares > 0 && s.currentPrice) {
      return sum + s.shares * s.currentPrice;
    }
    return sum;
  }, 0);

  const totalDayChange = stocks.reduce((sum, s) => {
    if (s.shares && s.shares > 0 && s.priceChange) {
      return sum + s.shares * s.priceChange;
    }
    return sum;
  }, 0);

  const hasPositionData = stocks.some(s => s.shares && s.shares > 0);

  return (
    <div>
      {/* Header */}
      <div className="flex items-end justify-between mb-8">
        <div>
          <div className="flex items-baseline gap-3">
            <h2 className="text-xl font-bold text-[hsl(var(--foreground))] mb-1">Your Holdings</h2>
            {hasPositionData && totalPortfolioValue > 0 && (
              <div className="flex items-baseline gap-2">
                <span className="text-lg font-semibold text-[hsl(var(--foreground))]">
                  ${totalPortfolioValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
                {totalDayChange !== 0 && (
                  <span
                    className={cn(
                      'text-sm font-medium',
                      totalDayChange > 0 ? 'text-green-600' : 'text-red-600'
                    )}
                  >
                    {totalDayChange >= 0 ? '+' : '-'}$
                    {Math.abs(totalDayChange).toLocaleString(undefined, {
                      maximumFractionDigits: 0,
                    })}{' '}
                    today
                  </span>
                )}
              </div>
            )}
          </div>
          <p className="text-[hsl(var(--muted-foreground))]">
            What do I believe right now, and has that belief changed?
          </p>
        </div>

        {/* Clear All Button */}
        <button
          onClick={() => setShowClearConfirm(true)}
          className="p-2 rounded-lg text-[hsl(var(--muted-foreground))] hover:text-red-600 hover:bg-red-50 transition-colors"
          title="Clear all stocks"
        >
          <Trash2 className="w-5 h-5" />
        </button>
      </div>

      {/* Controls Row — Risk Appetite + Sort */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          {/* Risk Appetite */}
          <div className={cn(
            'flex items-center gap-2 rounded-xl border px-3 py-2 shadow-sm',
            riskProfile === 'aggressive' && 'bg-red-50 border-red-200',
            riskProfile === 'moderate' && 'bg-blue-50 border-blue-200',
            riskProfile === 'conservative' && 'bg-emerald-50 border-emerald-200',
          )}
            title={
              riskProfile === 'aggressive' ? 'More buy signals on dips · Stop-Loss: -10% · Max Position: 30%'
              : riskProfile === 'moderate' ? 'Balanced — acts on conviction · Stop-Loss: -7% · Max Position: 25%'
              : 'Capital preservation first · Stop-Loss: -4% · Max Position: 20%'
            }
          >
            <Shield className={cn(
              'w-4 h-4',
              riskProfile === 'aggressive' && 'text-red-500',
              riskProfile === 'moderate' && 'text-blue-500',
              riskProfile === 'conservative' && 'text-emerald-500',
            )} />
            <select
              value={riskProfile}
              onChange={e => onRiskProfileChange(e.target.value as RiskProfile)}
              className={cn(
                'text-sm bg-transparent font-semibold focus:outline-none cursor-pointer pr-1',
                riskProfile === 'aggressive' && 'text-red-700',
                riskProfile === 'moderate' && 'text-blue-700',
                riskProfile === 'conservative' && 'text-emerald-700',
              )}
            >
              <option value="aggressive">Aggressive</option>
              <option value="moderate">Moderate</option>
              <option value="conservative">Conservative</option>
            </select>
          </div>

          <span className="text-[10px] text-[hsl(var(--muted-foreground))]">Affects AI buy/sell signals, not conviction scores</span>
        </div>

        {/* Sort dropdown */}
        <div className="flex items-center gap-2 bg-white rounded-xl border border-[hsl(var(--border))] px-3 py-2 shadow-sm">
          <ArrowUpDown className="w-4 h-4 text-[hsl(var(--muted-foreground))]" />
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value as SortOption)}
            className="text-sm bg-transparent text-[hsl(var(--foreground))] focus:outline-none cursor-pointer pr-2"
          >
            <option value="score-desc">Highest Score</option>
            <option value="score-asc">Lowest Score</option>
            <option value="change-pct">Biggest Drop (%)</option>
            <option value="change-dollar">Biggest Drop ($)</option>
            <option value="weight">Largest Position</option>
            <option value="ticker">Ticker A-Z</option>
            <option value="recent">Recently Added</option>
          </select>
        </div>
      </div>

      {/* Stock Cards */}
      <div className="space-y-4">
        {sortedStocks.map(stock => (
          <StockCard key={stock.ticker} stock={stock} onClick={() => onStockSelect(stock)} />
        ))}
      </div>

      {/* Clear All Confirmation Modal */}
      {showClearConfirm && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-50"
            onClick={() => setShowClearConfirm(false)}
          />
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm bg-white rounded-2xl shadow-2xl z-50 p-6">
            <div className="text-center">
              <div className="w-12 h-12 mx-auto mb-4 bg-red-100 rounded-full flex items-center justify-center">
                <Trash2 className="w-6 h-6 text-red-600" />
              </div>
              <h3 className="text-lg font-semibold text-[hsl(var(--foreground))] mb-2">
                Clear Portfolio?
              </h3>
              <p className="text-sm text-[hsl(var(--muted-foreground))] mb-6">
                This will remove all {stocks.length} stocks from your portfolio. This action cannot
                be undone.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowClearConfirm(false)}
                  className="flex-1 py-2.5 px-4 border border-[hsl(var(--border))] rounded-xl text-sm font-medium hover:bg-[hsl(var(--secondary))] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleClearAll}
                  className="flex-1 py-2.5 px-4 bg-red-600 text-white rounded-xl text-sm font-medium hover:bg-red-700 transition-colors"
                >
                  Clear All
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
