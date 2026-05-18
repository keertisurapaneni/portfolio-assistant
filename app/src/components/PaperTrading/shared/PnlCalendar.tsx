import { useMemo, useState } from 'react';
import { fmtUsd } from '../utils';

export interface PnlCalendarProps {
  data: Array<{ date: string; pnl: number }>;
}

const DAY_LABELS = ['M', '', 'W', '', 'F', '', ''];
const CELL_SIZE = 14;
const GAP = 2;

function interpolateColor(value: number, min: number, max: number): string {
  if (value === 0) return 'rgb(243 244 246)'; // gray-100
  if (value > 0) {
    const intensity = Math.min(value / max, 1);
    const r = Math.round(16 + (243 - 16) * (1 - intensity));
    const g = Math.round(185 + (244 - 185) * (1 - intensity));
    const b = Math.round(129 + (246 - 129) * (1 - intensity));
    return `rgb(${r} ${g} ${b})`;
  }
  const intensity = Math.min(Math.abs(value) / Math.abs(min), 1);
  const r = Math.round(239 + (243 - 239) * (1 - intensity));
  const g = Math.round(68 + (244 - 68) * (1 - intensity));
  const b = Math.round(68 + (246 - 68) * (1 - intensity));
  return `rgb(${r} ${g} ${b})`;
}

export function PnlCalendar({ data }: PnlCalendarProps) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; date: string; pnl: number } | null>(null);

  const { weeks, monthLabels, totalPnl, greenDays, redDays, minPnl, maxPnl } = useMemo(() => {
    const pnlByDate = new Map<string, number>();
    for (const d of data) {
      const dateKey = d.date.slice(0, 10);
      pnlByDate.set(dateKey, (pnlByDate.get(dateKey) ?? 0) + d.pnl);
    }

    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 91); // ~13 weeks
    // Align to Monday
    const dayOfWeek = start.getDay();
    const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    start.setDate(start.getDate() + diff);

    const weeks: Array<Array<{ date: string; pnl: number; inRange: boolean } | null>> = [];
    const monthLabels: Array<{ label: string; col: number }> = [];
    let lastMonth = -1;

    const cursor = new Date(start);
    let weekIdx = 0;

    while (cursor <= today) {
      const week: Array<{ date: string; pnl: number; inRange: boolean } | null> = [];
      for (let d = 0; d < 7; d++) {
        if (cursor > today) {
          week.push(null);
        } else {
          const dateStr = cursor.toISOString().slice(0, 10);
          const pnl = pnlByDate.get(dateStr) ?? 0;
          const isWeekday = cursor.getDay() !== 0 && cursor.getDay() !== 6;
          const hasTrade = pnlByDate.has(dateStr);
          week.push({ date: dateStr, pnl, inRange: isWeekday && hasTrade });

          const month = cursor.getMonth();
          if (month !== lastMonth) {
            monthLabels.push({
              label: cursor.toLocaleDateString('en-US', { month: 'short' }),
              col: weekIdx,
            });
            lastMonth = month;
          }
        }
        cursor.setDate(cursor.getDate() + 1);
      }
      weeks.push(week);
      weekIdx++;
    }

    let totalPnl = 0;
    let greenDays = 0;
    let redDays = 0;
    let minPnl = 0;
    let maxPnl = 0;
    for (const [, pnl] of pnlByDate) {
      totalPnl += pnl;
      if (pnl > 0) greenDays++;
      if (pnl < 0) redDays++;
      if (pnl < minPnl) minPnl = pnl;
      if (pnl > maxPnl) maxPnl = pnl;
    }

    return { weeks, monthLabels, totalPnl, greenDays, redDays, minPnl, maxPnl };
  }, [data]);

  const gridWidth = weeks.length * (CELL_SIZE + GAP) + 30;
  const gridHeight = 7 * (CELL_SIZE + GAP) + 20;

  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-4">
      <h3 className="text-sm font-semibold text-[hsl(var(--foreground))] mb-3">P&L Calendar</h3>

      <div className="overflow-x-auto relative">
        <svg width={gridWidth} height={gridHeight} className="block">
          {/* Month labels */}
          {monthLabels.map((m, i) => (
            <text
              key={i}
              x={30 + m.col * (CELL_SIZE + GAP)}
              y={10}
              className="fill-[hsl(var(--muted-foreground))]"
              fontSize={10}
            >
              {m.label}
            </text>
          ))}

          {/* Day labels */}
          {DAY_LABELS.map((label, i) => (
            label && (
              <text
                key={i}
                x={0}
                y={20 + i * (CELL_SIZE + GAP) + CELL_SIZE - 3}
                className="fill-[hsl(var(--muted-foreground))]"
                fontSize={10}
              >
                {label}
              </text>
            )
          ))}

          {/* Cells */}
          {weeks.map((week, colIdx) =>
            week.map((cell, rowIdx) => {
              if (!cell) return null;
              const x = 30 + colIdx * (CELL_SIZE + GAP);
              const y = 18 + rowIdx * (CELL_SIZE + GAP);
              const color = cell.inRange
                ? interpolateColor(cell.pnl, minPnl, maxPnl)
                : 'rgb(249 250 251)'; // gray-50 for weekends/no-trade days

              return (
                <rect
                  key={`${colIdx}-${rowIdx}`}
                  x={x}
                  y={y}
                  width={CELL_SIZE}
                  height={CELL_SIZE}
                  rx={2}
                  fill={color}
                  className="cursor-pointer transition-opacity hover:opacity-80"
                  onMouseEnter={(e) => {
                    const rect = (e.target as SVGRectElement).getBoundingClientRect();
                    setTooltip({ x: rect.left, y: rect.top - 40, date: cell.date, pnl: cell.pnl });
                  }}
                  onMouseLeave={() => setTooltip(null)}
                />
              );
            })
          )}
        </svg>

        {tooltip && (
          <div
            className="fixed z-50 px-2 py-1 rounded bg-gray-900 text-white text-xs shadow-lg pointer-events-none"
            style={{ left: tooltip.x, top: tooltip.y }}
          >
            <span className="font-medium">{tooltip.date}</span>
            <span className="ml-2">{fmtUsd(tooltip.pnl)}</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-4 mt-3 text-xs text-[hsl(var(--muted-foreground))]">
        <span>
          Total: <span className={totalPnl >= 0 ? 'text-emerald-600 font-medium' : 'text-red-600 font-medium'}>
            {fmtUsd(totalPnl)}
          </span>
        </span>
        <span className="text-emerald-600">{greenDays} green</span>
        <span className="text-red-500">{redDays} red</span>
      </div>
    </div>
  );
}
