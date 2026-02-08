import { AlertCircle } from 'lucide-react';
import { cn } from '../lib/utils';

interface ErrorBannerProps {
  /** The error/warning message to display */
  message: string;
  /** 'error' = red, 'warning' = amber */
  variant?: 'error' | 'warning';
  /** Size variant — 'sm' for compact inline, 'base' for standard blocks */
  size?: 'sm' | 'base';
  /** Optional className override */
  className?: string;
}

/**
 * Reusable error/warning banner used across the app.
 * Replaces 5+ copy-pasted error display blocks.
 */
export function ErrorBanner({
  message,
  variant = 'error',
  size = 'base',
  className,
}: ErrorBannerProps) {
  const isError = variant === 'error';

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border',
        size === 'sm' ? 'px-2 py-1 text-xs' : 'px-4 py-3 text-sm',
        isError
          ? 'border-red-200 bg-red-50 text-red-700'
          : 'border-amber-200 bg-amber-50 text-amber-700',
        className,
      )}
    >
      <AlertCircle className={cn('flex-shrink-0', size === 'sm' ? 'w-3 h-3' : 'w-4 h-4')} />
      <span className={size === 'sm' ? 'truncate max-w-[280px]' : ''}>{message}</span>
    </div>
  );
}
