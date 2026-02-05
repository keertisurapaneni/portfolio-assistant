import { useState } from 'react';
import { Plus, Check, TrendingUp, Gem, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import {
  quietCompounders,
  goldMineStocks,
  currentTheme,
  type EnhancedSuggestedStock,
} from '../data/suggestedFinds';
import { cn } from '../lib/utils';

interface SuggestedFindsProps {
  existingTickers: string[];
  onAddStock: (ticker: string, name: string) => void;
}

export function SuggestedFinds({ existingTickers, onAddStock }: SuggestedFindsProps) {
  return (
    <div className="space-y-10">
      {/* Header */}
      <div>
        <h2 className="text-xl font-bold text-[hsl(var(--foreground))] mb-1">Suggested Finds</h2>
        <p className="text-[hsl(var(--muted-foreground))]">
          Curated ideas to add to your portfolio
        </p>
      </div>

      {/* Quiet Compounders */}
      <section>
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-blue-50">
            <TrendingUp className="w-4 h-4 text-blue-600" />
          </div>
          <div>
            <h3 className="font-semibold text-[hsl(var(--foreground))]">Quiet Compounders</h3>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              Steady ROIC, low volatility, boring businesses that compound
            </p>
          </div>
        </div>
        <div className="border border-[hsl(var(--border))] rounded-xl overflow-hidden bg-white">
          {quietCompounders.map((stock, index) => (
            <StockRow
              key={stock.ticker}
              stock={stock}
              isInPortfolio={existingTickers.includes(stock.ticker)}
              onAdd={() => onAddStock(stock.ticker, stock.name)}
              isLast={index === quietCompounders.length - 1}
              accentColor="blue"
            />
          ))}
        </div>
      </section>

      {/* Gold Mines */}
      <section>
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 rounded-lg bg-amber-50">
            <Gem className="w-4 h-4 text-amber-600" />
          </div>
          <div>
            <h3 className="font-semibold text-[hsl(var(--foreground))]">Gold Mines</h3>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              Theme-driven opportunities
            </p>
          </div>
        </div>

        {/* Theme context - simplified */}
        <p className="text-sm text-amber-700 bg-amber-50 px-4 py-2.5 rounded-lg mb-4 border border-amber-100">
          <span className="font-medium">Current theme:</span> {currentTheme.name} —{' '}
          {currentTheme.description}
        </p>

        <div className="border border-[hsl(var(--border))] rounded-xl overflow-hidden bg-white">
          {goldMineStocks.map((stock, index) => (
            <StockRow
              key={stock.ticker}
              stock={stock}
              isInPortfolio={existingTickers.includes(stock.ticker)}
              onAdd={() => onAddStock(stock.ticker, stock.name)}
              isLast={index === goldMineStocks.length - 1}
              accentColor="amber"
            />
          ))}
        </div>
      </section>
    </div>
  );
}

interface StockRowProps {
  stock: EnhancedSuggestedStock;
  isInPortfolio: boolean;
  onAdd: () => void;
  isLast: boolean;
  accentColor: 'blue' | 'amber';
}

function StockRow({ stock, isInPortfolio, onAdd, isLast, accentColor }: StockRowProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const expandColor = accentColor === 'blue' ? 'text-blue-600' : 'text-amber-600';
  const bulletColor = accentColor === 'blue' ? 'bg-blue-500' : 'bg-amber-500';

  return (
    <div className={cn(!isLast && 'border-b border-[hsl(var(--border))]')}>
      {/* Two-line row layout */}
      <div className="px-4 py-3 hover:bg-[hsl(var(--secondary))/50] transition-colors">
        {/* Line 1: Ticker, Name, Actions */}
        <div className="flex items-center gap-3 mb-1">
          {/* Ticker & Link */}
          <div className="flex items-center gap-1.5">
            <span className="font-bold text-[hsl(var(--foreground))]">{stock.ticker}</span>
            <a
              href={`https://finance.yahoo.com/quote/${stock.ticker}/`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))] transition-colors"
              title="Yahoo Finance"
              onClick={e => e.stopPropagation()}
            >
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          {/* Company Name */}
          <span className="text-sm text-[hsl(var(--muted-foreground))]">{stock.name}</span>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Expand toggle */}
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className={cn(
              'p-1.5 rounded-lg hover:bg-[hsl(var(--secondary))] transition-colors',
              expandColor
            )}
            title={isExpanded ? 'Hide details' : 'More details'}
          >
            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>

          {/* Add button */}
          <button
            onClick={onAdd}
            disabled={isInPortfolio}
            className={cn(
              'p-2 rounded-lg transition-all flex-shrink-0',
              isInPortfolio
                ? 'bg-emerald-50 text-emerald-600 cursor-default'
                : 'bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--primary))] hover:text-white'
            )}
          >
            {isInPortfolio ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          </button>
        </div>

        {/* Line 2: Description (always visible) */}
        <p className="text-sm text-[hsl(var(--muted-foreground))] pl-0">{stock.reason}</p>
      </div>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="px-4 pb-4 pt-1 bg-[hsl(var(--secondary))/30]">
          {/* Metrics - clean pills */}
          {stock.metrics && stock.metrics.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {stock.metrics.map(metric => (
                <span
                  key={metric.label}
                  className="text-xs px-2.5 py-1 bg-white rounded-full border border-[hsl(var(--border))]"
                >
                  <span className="text-[hsl(var(--muted-foreground))]">{metric.label}:</span>{' '}
                  <span className="font-semibold text-[hsl(var(--foreground))]">
                    {metric.value}
                  </span>
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
        </div>
      )}
    </div>
  );
}
