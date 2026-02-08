import { Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';

type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg';

interface SpinnerProps {
  /** Size preset */
  size?: SpinnerSize;
  /** Optional className override */
  className?: string;
}

const sizeClasses: Record<SpinnerSize, string> = {
  xs: 'w-3 h-3',
  sm: 'w-3.5 h-3.5',
  md: 'w-4 h-4',
  lg: 'w-5 h-5',
};

export function Spinner({ size = 'md', className }: SpinnerProps) {
  return <Loader2 className={cn(sizeClasses[size], 'animate-spin', className)} />;
}
