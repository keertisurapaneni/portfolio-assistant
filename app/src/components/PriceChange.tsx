import { cn } from '../lib/utils';

interface PriceChangeProps {
  /** Current stock price */
  price: number;
  /** Dollar change (positive or negative) */
  change?: number | null;
  /** Percent change */
  changePercent?: number | null;
  /** Size variant */
  size?: 'sm' | 'base';
}

/**
 * Reusable price display with green/red change indicator.
 * Used in StockCard, StockDetail, and anywhere else a price + daily change is shown.
 */
export function PriceChange({
  price,
  change,
  changePercent,
  size = 'sm',
}: PriceChangeProps) {
  const hasChange =
    change !== undefined && change !== null &&
    changePercent !== undefined && changePercent !== null;

  const priceClass = size === 'base'
    ? 'text-lg font-semibold'
    : 'text-[hsl(var(--muted-foreground))] opacity-75';

  return (
    <span className={cn('inline-flex items-center gap-2 flex-wrap', size === 'sm' && 'text-xs')}>
      <span className={priceClass}>${price.toFixed(2)}</span>
      {hasChange && (
        <span
          className={cn(
            'font-medium',
            change > 0 && 'text-green-600',
            change < 0 && 'text-red-600',
            change === 0 && 'text-gray-500',
          )}
        >
          {change >= 0 ? '+' : '-'}${Math.abs(change).toFixed(2)}{' '}
          ({change >= 0 ? '+' : ''}{changePercent.toFixed(2)}%)
        </span>
      )}
    </span>
  );
}
