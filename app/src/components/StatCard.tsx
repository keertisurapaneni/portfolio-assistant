import { cn } from '../lib/utils';

interface StatCardProps {
  /** Small label above the value */
  label: string;
  /** The main value to display */
  value: string;
  /** Color theme for the label and background */
  color?: 'blue' | 'red' | 'green' | 'purple' | 'neutral';
  /** Optional className override */
  className?: string;
}

const colorMap = {
  blue:    { bg: 'bg-blue-50 border-blue-100',   label: 'text-blue-600' },
  red:     { bg: 'bg-red-50 border-red-100',      label: 'text-red-600' },
  green:   { bg: 'bg-green-50 border-green-100',   label: 'text-green-600' },
  purple:  { bg: 'bg-purple-50 border-purple-100', label: 'text-purple-600' },
  neutral: { bg: 'bg-[hsl(var(--secondary))]',     label: 'text-[hsl(var(--muted-foreground))]' },
};

/**
 * Reusable stat/metric card with a colored label and bold value.
 * Used in TradingSignals (Entry/Stop/Target/R:R), StockDetail (Shares/Avg Cost/Cost Basis),
 * and anywhere else a label+value pair is displayed.
 */
export function StatCard({ label, value, color = 'neutral', className }: StatCardProps) {
  const theme = colorMap[color];

  return (
    <div className={cn('p-3 rounded-lg border', theme.bg, className)}>
      <p className={cn('text-xs font-medium mb-0.5', theme.label)}>{label}</p>
      <p className="text-lg font-bold text-[hsl(var(--foreground))]">{value}</p>
    </div>
  );
}
