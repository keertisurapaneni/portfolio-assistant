import { type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/utils';

type BannerVariant = 'green' | 'amber' | 'blue' | 'purple';

interface DismissibleBannerProps {
  /** Banner content (icon + text are up to the consumer) */
  children: ReactNode;
  /** Color theme */
  variant?: BannerVariant;
  /** Callback when dismissed */
  onDismiss: () => void;
  /** Optional className override */
  className?: string;
}

const variantClasses: Record<BannerVariant, { container: string; dismiss: string }> = {
  green: {
    container: 'bg-gradient-to-r from-green-50 to-emerald-50 border-green-200',
    dismiss: 'text-green-400 hover:text-green-600',
  },
  amber: {
    container: 'bg-amber-50 border-amber-200',
    dismiss: 'text-amber-400 hover:text-amber-600',
  },
  blue: {
    container: 'bg-blue-50 border-blue-200',
    dismiss: 'text-blue-400 hover:text-blue-600',
  },
  purple: {
    container: 'bg-purple-50 border-purple-200',
    dismiss: 'text-purple-400 hover:text-purple-600',
  },
};

export function DismissibleBanner({
  children,
  variant = 'blue',
  onDismiss,
  className,
}: DismissibleBannerProps) {
  const theme = variantClasses[variant];

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-3 border rounded-xl',
        theme.container,
        className,
      )}
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {children}
      </div>
      <button
        onClick={onDismiss}
        className={cn('p-1 rounded transition-colors flex-shrink-0', theme.dismiss)}
        title="Dismiss"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
