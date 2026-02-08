import { ExternalLink } from 'lucide-react';

const getYahooFinanceUrl = (ticker: string) =>
  `https://finance.yahoo.com/quote/${ticker}/`;

interface TickerLabelProps {
  ticker: string;
  name?: string;
  /** Size variant: 'sm' for compact lists, 'base' for cards (default) */
  size?: 'sm' | 'base';
  /** Whether to stop event propagation on the Yahoo link (useful inside clickable cards) */
  stopPropagation?: boolean;
}

/**
 * Reusable inline label: TICKER  CompanyName  🔗
 * Consistent layout across StockCard, SuggestedFinds, and anywhere else.
 */
export function TickerLabel({
  ticker,
  name,
  size = 'base',
  stopPropagation = false,
}: TickerLabelProps) {
  const showName = name && name !== ticker;
  const tickerClass =
    size === 'sm'
      ? 'text-base font-bold text-[hsl(var(--foreground))]'
      : 'text-lg font-bold text-[hsl(var(--foreground))]';
  const nameClass =
    size === 'sm'
      ? 'text-xs text-[hsl(var(--muted-foreground))] truncate'
      : 'text-sm text-[hsl(var(--muted-foreground))] truncate';
  const iconSize = size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5';

  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className={`${tickerClass} flex-shrink-0`}>{ticker}</span>
      {showName && <span className={nameClass}>{name}</span>}
      <a
        href={getYahooFinanceUrl(ticker)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={stopPropagation ? e => e.stopPropagation() : undefined}
        className="p-0.5 rounded-md hover:bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))] transition-colors flex-shrink-0 self-center"
        title="View on Yahoo Finance"
      >
        <ExternalLink className={iconSize} />
      </a>
    </div>
  );
}
