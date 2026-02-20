import { cn } from '../../../lib/utils';

const styles: Record<string, string> = {
  PENDING: 'bg-slate-100 text-slate-600',
  SUBMITTED: 'bg-blue-100 text-blue-700',
  FILLED: 'bg-emerald-100 text-emerald-700',
  PARTIAL: 'bg-amber-100 text-amber-700',
  STOPPED: 'bg-red-100 text-red-700',
  TARGET_HIT: 'bg-emerald-100 text-emerald-700',
  CLOSED: 'bg-slate-100 text-slate-600',
  CANCELLED: 'bg-slate-100 text-slate-500',
  REJECTED: 'bg-red-100 text-red-700',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold',
      styles[status] ?? 'bg-slate-100 text-slate-600'
    )}>
      {status.replace('_', ' ')}
    </span>
  );
}
