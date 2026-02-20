import { cn } from '../../../lib/utils';

export type StatCardColor = 'blue' | 'green' | 'red' | 'amber';

export interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  subtitle?: string;
  color: StatCardColor;
}

const colors: Record<StatCardColor, string> = {
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
  green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  red: 'bg-red-50 text-red-700 border-red-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
};

export function StatCard({ icon, label, value, subtitle, color }: StatCardProps) {
  return (
    <div className={cn('rounded-xl border p-4', colors[color])}>
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <span className="text-xs font-medium opacity-75">{label}</span>
      </div>
      <p className="text-2xl font-bold">{value}</p>
      {subtitle && <p className="text-[10px] mt-0.5 opacity-60">{subtitle}</p>}
    </div>
  );
}
