import { useState, useEffect, useMemo, useCallback } from 'react';
import { Flame, AlertTriangle, TrendingUp, BarChart3, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { supabase } from '../../../lib/supabaseClient';
import { CLOSED_STATUSES } from '../../../../../shared/trade-status-sets.ts';
import { fmtUsd } from '../utils';

type StrategyRow = 'DAY_TRADE' | 'DAY_PENNY' | 'SWING_TRADE' | 'OVERALL';

interface DayCell {
  date: string;        // YYYY-MM-DD
  label: string;       // "5/12" or "Today"
  dayOfWeek: string;   // "Mon", "Tue", etc.
  pnl: number;
  tradeCount: number;
  isToday: boolean;
}

interface StreakState {
  mode: string;
  is_cold: boolean;
  rolling_win_rate: number | null;
}

const ROW_CONFIG: { key: StrategyRow; label: string; modes: string[] }[] = [
  { key: 'DAY_TRADE', label: 'Day Trades', modes: ['DAY_TRADE'] },
  { key: 'DAY_PENNY', label: 'Penny', modes: ['DAY_PENNY'] },
  { key: 'SWING_TRADE', label: 'Swing', modes: ['SWING_TRADE'] },
  { key: 'OVERALL', label: 'Overall', modes: ['DAY_TRADE', 'DAY_PENNY', 'SWING_TRADE'] },
];

const DAYS = 10;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function getLastNTradingDays(n: number): string[] {
  const dates: string[] = [];
  const d = new Date();
  while (dates.length < n) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      dates.push(`${yyyy}-${mm}-${dd}`);
    }
    d.setDate(d.getDate() - 1);
  }
  return dates.reverse();
}

function toDateLabel(isoDate: string, isToday: boolean): string {
  if (isToday) return 'Today';
  const [, m, d] = isoDate.split('-');
  return `${parseInt(m)}/${parseInt(d)}`;
}

function toDow(isoDate: string): string {
  const dt = new Date(isoDate + 'T12:00:00');
  return DOW[dt.getDay()];
}

export function StreakBoard() {
  const [grid, setGrid] = useState<Record<StrategyRow, DayCell[]> | null>(null);
  const [streakStates, setStreakStates] = useState<StreakState[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);

  const tradingDays = useMemo(() => getLastNTradingDays(DAYS), []);
  const todayStr = tradingDays[tradingDays.length - 1];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const since = tradingDays[0];

      const { data: trades } = await supabase
        .from('paper_trades')
        .select('mode, pnl, closed_at')
        .in('status', [...CLOSED_STATUSES])
        .not('pnl', 'is', null)
        .not('fill_price', 'is', null)
        .in('mode', ['DAY_TRADE', 'DAY_PENNY', 'SWING_TRADE'])
        .gte('closed_at', since + 'T00:00:00')
        .order('closed_at', { ascending: true });

      const { data: coldStates } = await supabase
        .from('strategy_streak_state')
        .select('mode, is_cold, rolling_win_rate');

      setStreakStates((coldStates ?? []) as StreakState[]);

      const byModeDate = new Map<string, { pnl: number; count: number }>();
      for (const t of trades ?? []) {
        if (!t.closed_at) continue;
        const dateStr = t.closed_at.slice(0, 10);
        for (const row of ROW_CONFIG) {
          if (row.modes.includes(t.mode)) {
            const key = `${row.key}|${dateStr}`;
            const existing = byModeDate.get(key) ?? { pnl: 0, count: 0 };
            existing.pnl += t.pnl ?? 0;
            existing.count += 1;
            byModeDate.set(key, existing);
          }
        }
      }

      const result = {} as Record<StrategyRow, DayCell[]>;
      for (const row of ROW_CONFIG) {
        result[row.key] = tradingDays.map(date => {
          const entry = byModeDate.get(`${row.key}|${date}`);
          return {
            date,
            label: toDateLabel(date, date === todayStr),
            dayOfWeek: toDow(date),
            pnl: entry?.pnl ?? 0,
            tradeCount: entry?.count ?? 0,
            isToday: date === todayStr,
          };
        });
      }

      setGrid(result);
    } catch (err) {
      console.error('[StreakBoard]', err);
    } finally {
      setLoading(false);
    }
  }, [tradingDays, todayStr]);

  useEffect(() => { load(); }, [load]);

  const streakInfo = useMemo(() => {
    if (!grid) return [];
    const info: { label: string; streak: number; cold: boolean; winRate: number | null }[] = [];
    for (const row of ROW_CONFIG) {
      if (row.key === 'OVERALL') continue;
      const cells = grid[row.key];
      const coldState = streakStates.find(s => s.mode === row.key);

      let streak = 0;
      for (let i = cells.length - 1; i >= 0; i--) {
        if (cells[i].tradeCount === 0) continue;
        if (cells[i].pnl > 0) streak++;
        else break;
      }

      info.push({
        label: row.label,
        streak,
        cold: coldState?.is_cold ?? false,
        winRate: coldState?.rolling_win_rate ? Math.round(coldState.rolling_win_rate * 100) : null,
      });
    }
    return info;
  }, [grid, streakStates]);

  if (loading && !grid) {
    return (
      <div className="rounded-xl border border-[hsl(var(--border))] bg-white px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]">
          <BarChart3 className="w-3.5 h-3.5 animate-pulse" />
          Loading streak data...
        </div>
      </div>
    );
  }

  if (!grid) return null;

  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-[hsl(var(--secondary))] border-b border-[hsl(var(--border))] hover:bg-[hsl(var(--secondary))]/80 transition-colors"
      >
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-[hsl(var(--muted-foreground))]" />
          <span className="text-sm font-semibold text-[hsl(var(--foreground))]">Strategy Streak</span>
          <span className="text-xs text-[hsl(var(--muted-foreground))]">Last {DAYS} days</span>
        </div>
        <div className="flex items-center gap-3">
          {/* Streak badges inline in header */}
          {!collapsed && streakInfo.map(s => (
            s.streak >= 2 ? (
              <span key={s.label} className="flex items-center gap-1 text-[10px] font-medium text-emerald-700">
                <Flame className="w-3 h-3 text-orange-500" />
                {s.label}: {s.streak}-day
              </span>
            ) : s.cold ? (
              <span key={s.label} className="flex items-center gap-1 text-[10px] font-medium text-amber-600">
                <AlertTriangle className="w-3 h-3" />
                {s.label}: 50% sizing
              </span>
            ) : null
          ))}
          {collapsed ? <ChevronDown className="w-4 h-4 text-[hsl(var(--muted-foreground))]" /> : <ChevronUp className="w-4 h-4 text-[hsl(var(--muted-foreground))]" />}
        </div>
      </button>

      {!collapsed && (
        <div className="px-3 py-3 overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="text-left text-[10px] font-medium text-[hsl(var(--muted-foreground))] pb-1.5 pr-2 w-20" />
                {tradingDays.map(date => {
                  const isToday = date === todayStr;
                  return (
                    <th key={date} className="text-center pb-1.5 px-0.5">
                      <div className={cn(
                        'text-[9px] font-medium leading-tight',
                        isToday ? 'text-[hsl(var(--primary))] font-bold' : 'text-[hsl(var(--muted-foreground))]'
                      )}>
                        {toDow(date)}
                      </div>
                      <div className={cn(
                        'text-[10px] leading-tight',
                        isToday ? 'text-[hsl(var(--primary))] font-bold' : 'text-[hsl(var(--muted-foreground))]'
                      )}>
                        {toDateLabel(date, isToday)}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {ROW_CONFIG.map((row) => {
                const isOverall = row.key === 'OVERALL';
                const coldState = streakStates.find(s => s.mode === row.key);
                return (
                  <tr key={row.key} className={cn(isOverall && 'border-t border-[hsl(var(--border))]')}>
                    <td className={cn(
                      'text-[11px] pr-2 py-1 whitespace-nowrap',
                      isOverall ? 'font-bold text-[hsl(var(--foreground))]' : 'font-medium text-[hsl(var(--muted-foreground))]'
                    )}>
                      <div className="flex items-center gap-1">
                        {row.label}
                        {coldState?.is_cold && (
                          <AlertTriangle className="w-3 h-3 text-amber-500" />
                        )}
                      </div>
                    </td>
                    {grid[row.key].map(cell => (
                      <td key={cell.date} className="text-center px-0.5 py-1">
                        <Cell cell={cell} bold={isOverall} isToday={cell.isToday} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Cell({ cell, bold, isToday }: { cell: DayCell; bold?: boolean; isToday?: boolean }) {
  if (cell.tradeCount === 0) {
    return (
      <div className={cn(
        'mx-auto w-full min-w-[52px] max-w-[64px] rounded-md py-1 text-[10px] tabular-nums',
        'bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))]/50',
        isToday && 'ring-1 ring-[hsl(var(--primary))]/30'
      )}>
        —
      </div>
    );
  }

  const isPositive = cell.pnl > 0;
  const isNegative = cell.pnl < 0;

  return (
    <div
      className={cn(
        'mx-auto w-full min-w-[52px] max-w-[64px] rounded-md py-1 text-[10px] tabular-nums transition-all',
        isPositive && 'bg-emerald-50 text-emerald-700 border border-emerald-200',
        isNegative && 'bg-red-50 text-red-700 border border-red-200',
        !isPositive && !isNegative && 'bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))]',
        bold && 'font-bold text-[11px]',
        isToday && 'ring-2 ring-[hsl(var(--primary))]/40 shadow-sm'
      )}
      title={`${cell.tradeCount} trade${cell.tradeCount !== 1 ? 's' : ''} on ${cell.date}`}
    >
      {fmtUsd(cell.pnl, 0, true)}
    </div>
  );
}
