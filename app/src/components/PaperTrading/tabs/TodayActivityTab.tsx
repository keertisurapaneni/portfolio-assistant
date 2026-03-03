import { useState } from 'react';
import { Zap, Play, Clock, PlayCircle, AlertCircle } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { AutoTradeEventRecord, PaperTrade, PendingStrategySignal } from '../../../lib/paperTradesApi';
import { executeSignal } from '../../../lib/paperTradesApi';
import { fmtUsd } from '../utils';

export interface TodayActivityTabProps {
  events: AutoTradeEventRecord[];
  trades: PaperTrade[];
  todaySignalsForExecute?: PendingStrategySignal[];
  onExecuteSignal?: () => void;
}

export function TodayActivityTab({ events, trades, todaySignalsForExecute = [], onExecuteSignal }: TodayActivityTabProps) {
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [executingAll, setExecutingAll] = useState(false);

  const handleExecuteSignal = async (signal: PendingStrategySignal) => {
    setExecutingId(signal.id);
    try {
      const out = await executeSignal(signal.id);
      if (out.ok) {
        const executed = (out as { executed?: boolean; reason?: string }).executed;
        const reason = (out as { reason?: string }).reason;
        onExecuteSignal?.();
        if (!executed && reason) {
          alert(`${signal.ticker} skipped: ${reason}`);
        }
      } else {
        console.error('[Execute signal]', out.error);
        alert(out.error ?? 'Execution failed');
      }
    } catch (err) {
      console.error('[Execute signal]', err);
      alert(err instanceof Error ? err.message : 'Execution failed — is auto-trader running on localhost:3001?');
    } finally {
      setExecutingId(null);
    }
  };

  const handleExecuteAll = async () => {
    if (todaySignalsForExecute.length === 0) return;
    setExecutingAll(true);
    let executed = 0;
    let skipped = 0;
    const skipReasons: string[] = [];
    for (const s of todaySignalsForExecute) {
      const out = await executeSignal(s.id);
      if (out.ok) {
        const didExec = (out as { executed?: boolean }).executed;
        const reason = (out as { reason?: string }).reason;
        if (didExec) {
          executed += 1;
          onExecuteSignal?.();
        } else {
          skipped += 1;
          skipReasons.push(`${s.ticker}: ${reason ?? 'unknown'}`);
        }
      } else {
        skipped += 1;
        skipReasons.push(`${s.ticker}: ${out.error ?? 'failed'}`);
        console.error(`[Execute signal] ${s.ticker}:`, out.error);
      }
    }
    setExecutingAll(false);
    onExecuteSignal?.(); // refresh to update list
    if (skipped > 0) {
      alert(executed > 0
        ? `${executed} executed, ${skipped} skipped:\n${skipReasons.slice(0, 5).join('\n')}${skipReasons.length > 5 ? '\n...' : ''}`
        : `All skipped:\n${skipReasons.slice(0, 5).join('\n')}${skipReasons.length > 5 ? '\n...' : ''}`);
    }
  };
  const tradesByTicker = new Map<string, PaperTrade[]>();
  for (const t of trades) {
    const arr = tradesByTicker.get(t.ticker) || [];
    arr.push(t);
    tradesByTicker.set(t.ticker, arr);
  }

  if (events.length === 0) {
    return (
      <div className="space-y-4">
        <div className="text-center py-12">
          <Zap className="w-10 h-10 text-[hsl(var(--muted-foreground))] opacity-40 mx-auto" />
          <p className="mt-3 text-sm text-[hsl(var(--muted-foreground))]">No trades executed today</p>
          <p className="text-xs text-[hsl(var(--muted-foreground))] opacity-70 mt-1">
            Scanner runs at 10 AM and 3:30 PM ET
          </p>
        </div>

        {todaySignalsForExecute.length > 0 && (
          <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))] flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">Execute Past Window</h3>
                <p className="text-[10px] text-[hsl(var(--muted-foreground))] mt-0.5">
                  Signals that missed the window or were skipped (no trades today) — execute or retry manually
                </p>
              </div>
              <button
                onClick={handleExecuteAll}
                disabled={executingId !== null || executingAll}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border flex-shrink-0',
                  'bg-emerald-600 border-emerald-700 text-white hover:bg-emerald-700',
                  (executingId !== null || executingAll) && 'opacity-50 cursor-not-allowed'
                )}
              >
                {executingAll ? (
                  <span className="animate-pulse">Executing all…</span>
                ) : (
                  <>
                    <PlayCircle className="w-3.5 h-3.5" />
                    Execute All
                  </>
                )}
              </button>
            </div>
            <div className="divide-y divide-[hsl(var(--border))]">
              {todaySignalsForExecute.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <span className="font-bold text-sm text-[hsl(var(--foreground))]">{s.ticker}</span>
                    <span className={cn('ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium', s.signal === 'BUY' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700')}>
                      {s.signal}
                    </span>
                    <span className="ml-1.5 text-[10px] text-[hsl(var(--muted-foreground))]">{s.mode.replace('_', ' ')}</span>
                    {s.source_name && (
                      <p className="text-[10px] text-[hsl(var(--muted-foreground))] truncate mt-0.5">{s.source_name}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {s.status === 'EXPIRED' && (
                      <span className="flex items-center gap-1 text-[10px] text-amber-600">
                        <Clock className="w-3 h-3" />
                        Expired
                      </span>
                    )}
                    {s.status === 'SKIPPED' && (
                      <span className="flex items-center gap-1 text-[10px] text-amber-600">
                        <AlertCircle className="w-3 h-3" />
                        Skipped
                      </span>
                    )}
                    <button
                      onClick={() => handleExecuteSignal(s)}
                      disabled={executingId !== null || executingAll}
                      className={cn(
                        'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-all',
                        'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100',
                        (executingId !== null || executingAll) && 'opacity-50 cursor-not-allowed'
                      )}
                    >
                      {executingId === s.id ? (
                        <span className="animate-pulse">Executing…</span>
                      ) : (
                        <>
                          <Play className="w-3 h-3" />
                          Execute
                        </>
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  const todayPnl = (() => {
    const countedTradeIds = new Set<string>();
    let sum = 0;
    for (const ev of events) {
      const matched = tradesByTicker.get(ev.ticker)?.find(t =>
        (t.pnl != null || ['FILLED', 'TARGET_HIT', 'STOPPED', 'CLOSED'].includes(t.status))
        && !countedTradeIds.has(t.id)
      );
      if (matched) {
        countedTradeIds.add(matched.id);
        sum += matched.pnl ?? 0;
      } else {
        const isSystemClose = ev.source === 'system' && !ev.mode;
        if (isSystemClose && ev.metadata) {
          const metaPnl = (ev.metadata as { pnl?: number }).pnl;
          if (metaPnl != null) sum += metaPnl;
        }
      }
    }
    return sum;
  })();

  return (
    <div className="space-y-3">
      {todayPnl !== 0 && (
        <div className="flex items-center justify-between rounded-lg bg-[hsl(var(--secondary))] px-4 py-2.5">
          <span className="text-sm font-medium text-[hsl(var(--muted-foreground))]">Today&apos;s Realized P&L</span>
          <span className={cn('text-sm font-bold tabular-nums', todayPnl > 0 ? 'text-emerald-600' : todayPnl < 0 ? 'text-red-600' : '')}>
            {fmtUsd(todayPnl, 2, true)}
          </span>
        </div>
      )}

      <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))] text-xs">
              <th className="text-left px-4 py-2.5 font-medium">Ticker</th>
              <th className="text-left px-4 py-2.5 font-medium">Signal</th>
              <th className="text-left px-4 py-2.5 font-medium">Type</th>
              <th className="text-left px-4 py-2.5 font-medium">Details</th>
              <th className="text-right px-4 py-2.5 font-medium">P&L</th>
              <th className="text-left px-4 py-2.5 font-medium">Status</th>
              <th className="text-right px-4 py-2.5 font-medium">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[hsl(var(--border))]">
            {events.map((event) => {
              const matched = tradesByTicker.get(event.ticker)?.find(t =>
                t.pnl != null || t.status === 'FILLED' || t.status === 'TARGET_HIT' || t.status === 'STOPPED' || t.status === 'CLOSED'
              );
              const isSystemClose = event.source === 'system' && !event.mode;
              const metaPnl = isSystemClose && event.metadata ? (event.metadata as { pnl?: number }).pnl : undefined;
              const eventPnl = metaPnl ?? matched?.pnl;
              const pnl = eventPnl ?? null;
              const CLOSED_STATUSES = ['CLOSED', 'TARGET_HIT', 'STOPPED', 'CANCELLED'];
              const isClosed = isSystemClose || (matched?.close_price != null) || CLOSED_STATUSES.includes(matched?.status ?? '');
              const isActive = !isClosed && matched && ['FILLED', 'PARTIAL'].includes(matched.status);
              const msg = event.message;
              const qtyMatch = msg.match(/(\d+)\s+shares.*?@\s*~?\$?([\d.]+)/i);

              const modeLabel = event.mode === 'DAY_TRADE' ? 'Day'
                : event.mode === 'SWING_TRADE' ? 'Swing'
                : event.mode === 'LONG_TERM' ? 'Long Term'
                : isSystemClose ? 'Close' : '—';

              const signalLabel = event.scanner_signal ?? (isSystemClose ? '—' : 'BUY');
              const signalColor = event.scanner_signal === 'SELL' ? 'bg-red-100 text-red-700'
                : isSystemClose ? 'bg-slate-100 text-slate-600'
                : 'bg-emerald-100 text-emerald-700';

              return (
                <tr key={event.id} className={cn('hover:bg-[hsl(var(--secondary))]/50', isSystemClose && 'bg-slate-50/50')}>
                  <td className="px-4 py-3 font-bold">{event.ticker}</td>
                  <td className="px-4 py-3">
                    <span className={cn('inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold', signalColor)}>
                      {signalLabel}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      'text-[10px] px-1.5 py-0.5 rounded font-medium',
                      isSystemClose ? 'bg-purple-50 text-purple-600' : 'bg-slate-100 text-slate-600'
                    )}>
                      {modeLabel}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-[hsl(var(--muted-foreground))]">
                    {qtyMatch ? `${qtyMatch[1]} shares @ $${qtyMatch[2]}` : event.message.slice(0, 60)}
                  </td>
                  <td className={cn(
                    'px-4 py-3 text-right tabular-nums font-semibold',
                    pnl != null && pnl > 0 ? 'text-emerald-600' : pnl != null && pnl < 0 ? 'text-red-600' : ''
                  )}>
                    {pnl != null ? fmtUsd(pnl, 2, true) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {isClosed ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-medium">Closed</span>
                    ) : isActive ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 font-medium">Active</span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 font-medium">Pending</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-[hsl(var(--muted-foreground))] tabular-nums">
                    {new Date(event.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {todaySignalsForExecute.length > 0 && (
        <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))] flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">Execute Past Window</h3>
              <p className="text-[10px] text-[hsl(var(--muted-foreground))] mt-0.5">
                Today&apos;s signals that missed the execution window — execute manually
              </p>
            </div>
            <button
              onClick={handleExecuteAll}
              disabled={executingId !== null || executingAll}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border flex-shrink-0',
                'bg-emerald-600 border-emerald-700 text-white hover:bg-emerald-700',
                (executingId !== null || executingAll) && 'opacity-50 cursor-not-allowed'
              )}
            >
              {executingAll ? (
                <span className="animate-pulse">Executing all…</span>
              ) : (
                <>
                  <PlayCircle className="w-3.5 h-3.5" />
                  Execute All
                </>
              )}
            </button>
          </div>
          <div className="divide-y divide-[hsl(var(--border))]">
            {todaySignalsForExecute.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <span className="font-bold text-sm text-[hsl(var(--foreground))]">{s.ticker}</span>
                  <span className={cn('ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium', s.signal === 'BUY' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700')}>
                    {s.signal}
                  </span>
                  <span className="ml-1.5 text-[10px] text-[hsl(var(--muted-foreground))]">{s.mode.replace('_', ' ')}</span>
                  {s.source_name && (
                    <p className="text-[10px] text-[hsl(var(--muted-foreground))] truncate mt-0.5">{s.source_name}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {s.status === 'EXPIRED' && (
                    <span className="flex items-center gap-1 text-[10px] text-amber-600">
                      <Clock className="w-3 h-3" />
                      Expired
                    </span>
                  )}
                  {s.status === 'SKIPPED' && (
                    <span className="flex items-center gap-1 text-[10px] text-amber-600">
                      <AlertCircle className="w-3 h-3" />
                      Skipped
                    </span>
                  )}
                  <button
                    onClick={() => handleExecuteSignal(s)}
                    disabled={executingId !== null || executingAll}
                    className={cn(
                      'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-all',
                      'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100',
                      (executingId !== null || executingAll) && 'opacity-50 cursor-not-allowed'
                    )}
                  >
                    {executingId === s.id ? (
                      <span className="animate-pulse">Executing…</span>
                    ) : (
                      <>
                        <Play className="w-3 h-3" />
                        Execute
                      </>
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
