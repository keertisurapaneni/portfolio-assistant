import { useState, useMemo } from 'react';
import { Zap, Play, Clock, PlayCircle, AlertCircle, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { AutoTradeEventRecord, PaperTrade, PendingStrategySignal } from '../../../lib/paperTradesApi';
import { executeSignal } from '../../../lib/paperTradesApi';
import { fmtUsd } from '../utils';
import { CLOSED_STATUSES, EXCLUDED_STATUSES } from '../../../../../shared/trade-status-sets.ts';

/** Convert raw failure_reason codes into human-readable labels. */
function formatSkipReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const r = reason.toLowerCase();
  // Entry trigger reasons (most common for influencer signals)
  if (r.includes('entry trigger not reached') || r.includes('expired — entry trigger')) return reason.replace(/^expired — /i, '');
  if (r.includes('execution window closed')) return 'Window closed — entry price was never reached';
  if (r.includes('strategy marked x') || r.includes('consecutive losses')) return `Strategy paused — ${reason.match(/\d+/)?.[0] ?? '3'}+ consecutive losing days`;
  if (r.includes('duplicate active trade')) return 'Already have an active trade for this ticker';
  if (r.includes('volume') || r.includes('vol')) return 'Volume too low — not enough intraday activity';
  if (r.includes('spy') && (r.includes('market') || r.includes('align'))) return 'SPY market direction against this trade';
  if (r.includes('direction mismatch') || r.includes('fa_direction')) return 'Full analysis recommends opposite direction';
  if (r.includes('hold') || r.includes('fa_hold')) return 'Full analysis says HOLD — no clear edge';
  if (r.includes('confidence') || r.includes('fa_conf')) return `FA confidence too low (${reason.match(/[\d.]+/g)?.slice(-2).join(' vs ') ?? ''})`;
  if (r.includes('risk/reward') || r.includes('risk_reward') || r.includes('rr_')) return `Risk/reward too low — below 1:1.8 minimum`;
  if (r.includes('pre-trade') || r.includes('pre_trade')) return 'Risk check blocked: drawdown / allocation / sector / earnings';
  if (r.includes('drawdown')) return 'Portfolio drawdown limit reached';
  if (r.includes('allocation') || r.includes('cap')) return 'Allocation cap reached';
  if (r.includes('price') && r.includes('far')) return 'Price moved too far from entry level';
  if (r.includes('sector')) return 'Sector concentration limit reached';
  if (r.includes('earnings')) return 'Earnings blackout period';
  return reason;
}

import type { AccountView } from '../../../contexts/AccountContext';

function AccountDot({ type }: { type?: 'paper' | 'live' }) {
  if (!type) return null;
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${type === 'live' ? 'bg-emerald-500' : 'bg-slate-400'}`}
      title={type === 'live' ? 'Live trade' : 'Paper trade'}
    />
  );
}

export interface TodayActivityTabProps {
  events: AutoTradeEventRecord[];
  trades: PaperTrade[];
  todaySignalsForExecute?: PendingStrategySignal[];
  onExecuteSignal?: () => void;
  ibRealizedPnl?: number | null;
  accountView?: AccountView;
}

type FilterMode = 'all' | 'day' | 'penny' | 'long_term' | 'gainers' | 'losers';
type SortKey = 'ticker' | 'pnl' | 'time' | null;
type SortDir = 'asc' | 'desc';

function isTradingDay(): boolean {
  const now = new Date();
  const day = now.getDay();
  return day !== 0 && day !== 6; // 0=Sun, 6=Sat
}

export function TodayActivityTab({ events, trades, todaySignalsForExecute = [], onExecuteSignal, ibRealizedPnl, accountView }: TodayActivityTabProps) {
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [executingAll, setExecutingAll] = useState(false);
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [sortKey, setSortKey] = useState<SortKey>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const todayStart = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  })();

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
  const todayISO = todayStart.toISOString();
  const tradesByTicker = new Map<string, PaperTrade[]>();
  for (const t of trades) {
    const openedToday = t.opened_at && t.opened_at >= todayISO;
    const closedToday = t.closed_at && t.closed_at >= todayISO;
    if (!openedToday && !closedToday) continue;
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
                    {s.failure_reason && (
                      <p className="text-[10px] text-red-500 mt-0.5 max-w-xs truncate" title={s.failure_reason}>
                        {formatSkipReason(s.failure_reason)}
                      </p>
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

  const computeEventPnl = (evList: typeof events) => {
    const countedTradeIds = new Set<string>();
    const AUTO_CLOSE = new Set(['system', 'lt_auto_sell', 'swing_expiry', 'capital_pressure']);
    let sum = 0;
    for (const ev of evList) {
      const matched = tradesByTicker.get(ev.ticker)?.find(t =>
        (t.pnl != null || ['FILLED', 'TARGET_HIT', 'STOPPED', 'CLOSED'].includes(t.status))
        && !countedTradeIds.has(t.id)
      );
      if (matched) {
        countedTradeIds.add(matched.id);
        // Only count P&L from trades with a confirmed exit price.
        // A trade marked CLOSED with pnl but no close_price is a failed close (DB out of sync with IB).
        if (matched.pnl != null && matched.close_price != null) {
          sum += matched.pnl;
        }
      } else if (AUTO_CLOSE.has(ev.source ?? '') && ev.metadata) {
        const meta = ev.metadata as { pnl?: number; realizedPnl?: number; gainPct?: number; qty?: number; entryPrice?: number };
        const metaPnl = meta.pnl ?? meta.realizedPnl
          ?? (meta.gainPct != null && meta.qty != null && meta.entryPrice != null
            ? (meta.gainPct / 100) * meta.qty * meta.entryPrice
            : undefined);
        if (metaPnl != null) sum += metaPnl;
      }
    }
    return sum;
  };

  const allEventPnl = useMemo(() => computeEventPnl(events), [events, tradesByTicker]);
  const effectiveIbPnl = isTradingDay() ? ibRealizedPnl : null;
  const todayPnlAll = effectiveIbPnl ?? allEventPnl;

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'pnl' ? 'desc' : 'asc');
    }
  }

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ChevronsUpDown className="inline w-3 h-3 ml-0.5 opacity-40" />;
    return sortDir === 'asc'
      ? <ChevronUp className="inline w-3 h-3 ml-0.5 opacity-80" />
      : <ChevronDown className="inline w-3 h-3 ml-0.5 opacity-80" />;
  }

  const filteredSortedEvents = useMemo(() => {
    let filtered = events;

    if (filterMode !== 'all') {
      filtered = events.filter(ev => {
        const mode = ev.mode;
        if (filterMode === 'day') return mode === 'DAY_TRADE' || mode === 'DAY_PENNY';
        if (filterMode === 'penny') return mode === 'DAY_PENNY';
        if (filterMode === 'long_term') return mode === 'LONG_TERM' || mode === 'SWING_TRADE';
        if (filterMode === 'gainers' || filterMode === 'losers') {
          const trade = tradesByTicker.get(ev.ticker)?.find(t => t.pnl != null);
          const pnl = trade?.pnl ?? null;
          if (filterMode === 'gainers') return pnl != null && pnl > 0;
          if (filterMode === 'losers') return pnl != null && pnl < 0;
        }
        return true;
      });
    }

    if (!sortKey) return filtered;

    return [...filtered].sort((a, b) => {
      let aVal: string | number | null = null;
      let bVal: string | number | null = null;

      if (sortKey === 'ticker') {
        aVal = a.ticker;
        bVal = b.ticker;
      } else if (sortKey === 'time') {
        aVal = a.created_at;
        bVal = b.created_at;
      } else if (sortKey === 'pnl') {
        const matchA = tradesByTicker.get(a.ticker)?.find(t => t.pnl != null);
        const matchB = tradesByTicker.get(b.ticker)?.find(t => t.pnl != null);
        aVal = matchA?.pnl ?? null;
        bVal = matchB?.pnl ?? null;
      }

      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return 1;
      if (bVal === null) return -1;

      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [events, filterMode, sortKey, sortDir, tradesByTicker]);

  const filteredPnl = useMemo(() => computeEventPnl(filteredSortedEvents), [filteredSortedEvents, tradesByTicker]);
  const useIbPnl = filterMode === 'all' && effectiveIbPnl != null;
  const displayPnl = useIbPnl ? effectiveIbPnl : filterMode === 'all' ? todayPnlAll : filteredPnl;
  const pnlLabel = filterMode === 'all' ? "Today's Realized P&L"
    : filterMode === 'day' ? 'Day Trade P&L'
    : filterMode === 'penny' ? 'Penny P&L'
    : filterMode === 'long_term' ? 'LT / Swing P&L'
    : filterMode === 'gainers' ? 'Gainers P&L'
    : 'Losers P&L';

  return (
    <div className="space-y-3">
      {displayPnl !== 0 && (
        <div className="flex items-center justify-between rounded-lg bg-[hsl(var(--secondary))] px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-[hsl(var(--muted-foreground))]">{pnlLabel}</span>
            {useIbPnl && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-semibold">IB</span>
            )}
          </div>
          <span className={cn('text-sm font-bold tabular-nums', displayPnl > 0 ? 'text-emerald-600' : displayPnl < 0 ? 'text-red-600' : '')}>
            {fmtUsd(displayPnl, 2, true)}
          </span>
        </div>
      )}

      {/* Filter + count bar */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {(['all', 'day', 'penny', 'long_term'] as FilterMode[]).map(f => (
          <button
            key={f}
            onClick={() => setFilterMode(f)}
            className={cn(
              'px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors',
              filterMode === f
                ? 'bg-[hsl(var(--foreground))] text-[hsl(var(--background))] border-[hsl(var(--foreground))]'
                : 'bg-white text-[hsl(var(--muted-foreground))] border-[hsl(var(--border))] hover:border-[hsl(var(--foreground))]/40'
            )}
          >
            {f === 'all' ? 'All' : f === 'day' ? 'Day Trades' : f === 'penny' ? 'Penny' : 'LT / Swing'}
          </button>
        ))}
        <button
          onClick={() => setFilterMode(filterMode === 'gainers' ? 'all' : 'gainers')}
          className={cn(
            'px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors',
            filterMode === 'gainers'
              ? 'bg-emerald-600 text-white border-emerald-700'
              : 'bg-white text-emerald-700 border-emerald-200 hover:border-emerald-400'
          )}
        >
          Gainers
        </button>
        <button
          onClick={() => setFilterMode(filterMode === 'losers' ? 'all' : 'losers')}
          className={cn(
            'px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors',
            filterMode === 'losers'
              ? 'bg-red-600 text-white border-red-700'
              : 'bg-white text-red-700 border-red-200 hover:border-red-400'
          )}
        >
          Losers
        </button>
        {filterMode !== 'all' && (
          <span className="text-[10px] text-[hsl(var(--muted-foreground))] ml-1">
            {filteredSortedEvents.length} of {events.length}
          </span>
        )}
      </div>

      <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))] text-xs">
              <th
                className="text-left px-4 py-2.5 font-medium cursor-pointer select-none hover:text-[hsl(var(--foreground))]"
                onClick={() => handleSort('ticker')}
              >
                Ticker <SortIcon col="ticker" />
              </th>
              <th className="text-left px-4 py-2.5 font-medium">Signal</th>
              <th className="text-left px-4 py-2.5 font-medium">Type</th>
              <th className="text-left px-4 py-2.5 font-medium">Details</th>
              <th
                className="text-right px-4 py-2.5 font-medium cursor-pointer select-none hover:text-[hsl(var(--foreground))]"
                onClick={() => handleSort('pnl')}
              >
                P&L <SortIcon col="pnl" />
              </th>
              <th className="text-left px-4 py-2.5 font-medium">Status</th>
              <th
                className="text-right px-4 py-2.5 font-medium cursor-pointer select-none hover:text-[hsl(var(--foreground))]"
                onClick={() => handleSort('time')}
              >
                Time <SortIcon col="time" />
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[hsl(var(--border))]">
            {filteredSortedEvents.map((event) => {
              const matched = tradesByTicker.get(event.ticker)?.find(t =>
                t.pnl != null || t.status === 'FILLED' || t.status === 'TARGET_HIT' || t.status === 'STOPPED' || t.status === 'CLOSED'
              );

              const isPositionSync = event.source === 'system' && !event.mode;
              const AUTO_CLOSE_SOURCES = new Set(['lt_auto_sell', 'swing_expiry', 'capital_pressure']);
              const isAutoClose = AUTO_CLOSE_SOURCES.has(event.source ?? '');
              const metaPnl = isPositionSync && event.metadata ? (event.metadata as { pnl?: number }).pnl : undefined;
              const eventPnl = metaPnl ?? matched?.pnl;
              const pnl = eventPnl ?? null;
              const terminalStatuses = [...CLOSED_STATUSES, ...EXCLUDED_STATUSES] as string[];
              const isClosed = isPositionSync || isAutoClose || (matched?.close_price != null) || terminalStatuses.includes(matched?.status ?? '');
              const isActive = !isClosed && matched && ['FILLED', 'PARTIAL'].includes(matched.status);
              const msg = event.message;
              // Match "7 shares @ $675" OR "BUY 7 @ $675" (external signal format)
              const sharesMatch = msg.match(/(\d+)\s+shares.*?@\s*~?\$?([\d.]+)/i);
              const externalMatch = msg.match(/(?:BUY|SELL)\s+(\d+)\s+@\s*~?\$?([\d.]+)/i);
              const qtyMatch = sharesMatch ?? externalMatch;

              const sourceLabel = event.source === 'scanner' ? 'Trade signal'
                : event.source === 'external_signal' ? `External signal + ${event.strategy_source}`
                : event.source === 'suggested_finds' ? 'Suggested find'
                : event.source === 'dip_buy' ? 'Dip buy'
                : event.source === 'profit_take' ? 'Profit take'
                : event.source === 'loss_cut' ? 'Loss cut'
                : event.source === 'lt_auto_sell' ? 'LT auto-exit'
                : event.source === 'swing_expiry' ? 'Swing expiry'
                : event.source === 'capital_pressure' ? 'Capital freed'
                : event.source === 'system' ? 'System'
                : event.source === 'manual' ? 'Manual'
                : 'Trade';

              const modeLabel = event.mode === 'DAY_TRADE' ? 'Day'
                : event.mode === 'DAY_PENNY' ? 'Penny'
                : event.mode === 'SWING_TRADE' ? 'Swing'
                : event.mode === 'LONG_TERM' ? 'Long Term'
                : isPositionSync ? 'Close' : '—';

              const SELL_SOURCES = new Set(['loss_cut', 'profit_take', 'lt_auto_sell', 'swing_expiry', 'capital_pressure']);
              const inferredSignal = isPositionSync ? '—'
                : SELL_SOURCES.has(event.source ?? '') ? 'SELL'
                : 'BUY';
              const entrySignal = event.scanner_signal ?? inferredSignal;
              const isSell = entrySignal === 'SELL';
              const signalLabel = entrySignal;
              const signalColor = isSell ? 'bg-red-100 text-red-700'
                : isPositionSync ? 'bg-slate-100 text-slate-600'
                : 'bg-emerald-100 text-emerald-700';

              return (
                <tr key={event.id} className={cn('hover:bg-[hsl(var(--secondary))]/50', (isPositionSync || isAutoClose) && 'bg-slate-50/50')}>
                  <td className="px-4 py-3 font-bold">
                    <span className="inline-flex items-center gap-1.5">
                      {accountView === 'live' && <AccountDot type="live" />}
                      {event.ticker}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn('inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold', signalColor)}>
                      {signalLabel}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      'text-[10px] px-1.5 py-0.5 rounded font-medium',
                      isPositionSync ? 'bg-purple-50 text-purple-600' : 'bg-slate-100 text-slate-600'
                    )}>
                      {modeLabel}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-[hsl(var(--muted-foreground))]">
                    <span className="font-medium text-[hsl(var(--foreground))]">{sourceLabel}</span>
                    {qtyMatch
                      ? <span> · {qtyMatch[1]} shares @ ${qtyMatch[2]}</span>
                      : <span> · {msg.replace(/^External signal executed:\s*/i, '').slice(0, 45)}</span>
                    }
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
