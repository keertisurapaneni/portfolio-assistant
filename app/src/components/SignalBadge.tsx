import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '../lib/utils';

type Recommendation = 'BUY' | 'SELL' | 'HOLD' | string | null | undefined;

interface SignalBadgeProps {
  /** BUY, SELL, HOLD, or falsy for "No Action" */
  signal: Recommendation;
  /** 'lg' = TradingSignals hero badge, 'md' = StockDetail, 'sm' = StockCard inline */
  size?: 'sm' | 'md' | 'lg';
  /** Show pulse animation (only on lg) */
  pulse?: boolean;
  /** Dashed border when position data is missing */
  dashed?: boolean;
}

/**
 * Reusable signal badge for BUY / SELL / HOLD across the app.
 * Consistent colors and iconography everywhere.
 */
export function SignalBadge({
  signal,
  size = 'md',
  pulse = false,
  dashed = false,
}: SignalBadgeProps) {
  const normalized = signal?.toUpperCase?.() ?? '';

  // ── Size presets ──
  const sizeClasses = {
    sm: 'px-2.5 py-1 text-xs gap-1',
    md: 'px-3 py-1 text-sm gap-1.5',
    lg: 'px-4 py-1.5 text-sm gap-1.5 tracking-wide uppercase shadow-md',
  }[size];

  const iconSize = { sm: 'w-3 h-3', md: 'w-3.5 h-3.5', lg: 'w-4 h-4' }[size];

  // ── Color presets ──
  if (normalized === 'BUY') {
    return (
      <span
        className={cn(
          'inline-flex items-center font-bold rounded-full border',
          sizeClasses,
          size === 'lg'
            ? 'bg-emerald-500 text-white border-emerald-500 shadow-emerald-500/20'
            : 'bg-green-100 text-green-800 border-green-300 shadow-sm',
          pulse && size === 'lg' && 'pulse-buy',
          dashed && 'border-dashed opacity-75',
        )}
      >
        {size === 'sm' ? '🎯' : <TrendingUp className={iconSize} />} BUY
        {dashed && <span className="text-[0.6rem]">*</span>}
      </span>
    );
  }

  if (normalized === 'SELL') {
    return (
      <span
        className={cn(
          'inline-flex items-center font-bold rounded-full border',
          sizeClasses,
          size === 'lg'
            ? 'bg-red-500 text-white border-red-500 shadow-red-500/20'
            : 'bg-red-100 text-red-700 border-red-300',
          pulse && size === 'lg' && 'pulse-sell',
          dashed && 'border-dashed opacity-75',
        )}
      >
        {size === 'sm' ? '🔻' : <TrendingDown className={iconSize} />} SELL
        {dashed && <span className="text-[0.6rem]">*</span>}
      </span>
    );
  }

  // HOLD / No Action
  return (
    <span
      className={cn(
        'inline-flex items-center font-bold rounded-full border',
        sizeClasses,
        size === 'lg'
          ? 'bg-amber-400 text-white border-amber-400 shadow-sm'
          : 'bg-gray-100 text-gray-700 border-gray-300',
      )}
    >
      {size === 'lg' ? <Minus className={iconSize} /> : '—'} {normalized === 'HOLD' ? 'HOLD' : 'No Action'}
    </span>
  );
}
