import { useState, useEffect, useMemo, useCallback } from 'react';
import { Flame, AlertTriangle, TrendingUp, BarChart3, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { supabase } from '../../../lib/supabaseClient';
import { CLOSED_STATUSES } from '../../../../../shared/trade-status-sets.ts';
import { fmtUsd } from '../utils';

type StrategyRow = 'DAY_TRADE' | 'DAY_PENNY' | 'SWING_TRADE' | 'OVERALL';

interface DayCell {
  date: string;
  label: string;
  dayOfWeek: string;
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

  const visibleRows = useMemo(() => {
    if (!grid) return [];
    const strategyRows = ROW_CONFIG.filter(r => r.key !== 'OVERALL');
    const activeRows = strategyRows.filter(r =>
      grid[r.key].some(c => c.tradeCount > 0)
    );
    const showOverall = activeRows.length > 1;
    return [...activeRows, ...(showOverall ? [ROW_CONFIG.find(r => r.key === 'OVERALL')!] : [])];
  }, [grid]);

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

  if (!grid || visibleRows.length === 0) return null;

  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between px-4 py-2 bg-[hsl(var(--secondary))] border-b border-[hsl(var(--border))] hover:bg-[hsl(var(--secondary))]/80 transition-colors"
      >
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-[hsl(var(--muted-foreground))]" />
          <span className="text-sm font-semibold text-[hsl(var(--foreground))]">Strategy Streak</span>
          <span className="text-[11px] text-[hsl(var(--muted-foreground))]">Last {DAYS} days</span>
        </div>
        <div className="flex items-center gap-3">
          {streakInfo.map(s => (
            s.streak >= 2 ? (
              <span key={s.label} className="flex items-center gap-1 text-[10px] font-semibold text-emerald-600">
                <Flame className="w-3 h-3 text-orange-500" />
                {s.label}: {s.streak}-day streak
              </span>
            ) : s.cold ? (
              <span key={s.label} className="flex items-center gap-1 text-[10px] font-semibold text-amber-600">
                <AlertTriangle className="w-3 h-3" />
                {s.label}: half size
              </span>
            ) : null
          ))}
          {collapsed ? <ChevronDown className="w-4 h-4 text-[hsl(var(--muted-foreground))]" /> : <ChevronUp className="w-4 h-4 text-[hsl(var(--muted-foreground))]" />}
        </div>
      </button>

      {!collapsed && (
        <div className="px-4 py-3 space-y-2">
          {/* Date headers */}
          <div className="flex items-end gap-0">
            <div className="w-[72px] flex-shrink-0" />
            <div className="flex-1 grid gap-1" style={{ gridTemplateColumns: `repeat(${DAYS}, 1fr)` }}>
              {tradingDays.map(date => {
                const isToday = date === todayStr;
                return (
                  <div key={date} className="text-center">
                    <div className={cn(
                      'text-[9px] leading-none',
                      isToday ? 'text-[hsl(var(--primary))] font-bold' : 'text-[hsl(var(--muted-foreground))]'
                    )}>
                      {toDow(date)}
                    </div>
                    <div className={cn(
                      'text-[10px] leading-tight mt-0.5',
                      isToday ? 'text-[hsl(var(--primary))] font-bold' : 'text-[hsl(var(--muted-foreground))]'
                    )}>
                      {toDateLabel(date, isToday)}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="w-[60px] flex-shrink-0" />
          </div>

          {/* Strategy rows */}
          {visibleRows.map((row) => {
            const isOverall = row.key === 'OVERALL';
            const coldState = streakStates.find(s => s.mode === row.key);
            const cells = grid[row.key];
            const periodTotal = cells.reduce((sum, c) => sum + c.pnl, 0);

            return (
              <div key={row.key} className={cn(isOverall && 'pt-1.5 border-t border-[hsl(var(--border))]')}>
                <div className="flex items-center gap-0">
                  {/* Row label */}
                  <div className={cn(
                    'w-[72px] flex-shrink-0 text-[11px] pr-2 truncate',
                    isOverall ? 'font-bold text-[hsl(var(--foreground))]' : 'font-medium text-[hsl(var(--muted-foreground))]'
                  )}>
                    <span className="flex items-center gap-1">
                      {row.label}
                      {coldState?.is_cold && <AlertTriangle className="w-3 h-3 text-amber-500 flex-shrink-0" />}
                    </span>
                  </div>

                  {/* Cells grid */}
                  <div className="flex-1 grid gap-1" style={{ gridTemplateColumns: `repeat(${DAYS}, 1fr)` }}>
                    {cells.map(cell => (
                      <Cell key={cell.date} cell={cell} bold={isOverall} />
                    ))}
                  </div>

                  {/* Period total */}
                  <div className={cn(
                    'w-[60px] flex-shrink-0 text-right text-[10px] tabular-nums font-semibold pl-2',
                    periodTotal > 0 ? 'text-emerald-600' : periodTotal < 0 ? 'text-red-600' : 'text-[hsl(var(--muted-foreground))]'
                  )}>
                    {fmtUsd(periodTotal, 0, true)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Cell({ cell, bold }: { cell: DayCell; bold?: boolean }) {
  const noTrades = cell.tradeCount === 0;
  const isPositive = cell.pnl > 0;
  const isNegative = cell.pnl < 0;

  return (
    <div
      className={cn(
        'rounded-md py-1.5 text-center text-[10px] tabular-nums transition-all',
        noTrades && 'bg-slate-50 text-slate-300',
        isPositive && 'bg-emerald-100 text-emerald-800 font-medium',
        isNegative && 'bg-red-100 text-red-800 font-medium',
        !noTrades && !isPositive && !isNegative && 'bg-slate-100 text-slate-500',
        bold && 'font-bold',
        cell.isToday && !noTrades && 'ring-2 ring-[hsl(var(--primary))]/30',
        cell.isToday && noTrades && 'ring-1 ring-[hsl(var(--primary))]/20',
      )}
      title={noTrades ? `No trades on ${cell.date}` : `${cell.tradeCount} trade${cell.tradeCount !== 1 ? 's' : ''} on ${cell.date}`}
    >
      {noTrades ? '·' : fmtUsd(cell.pnl, 0, true)}
    </div>
  );
}
