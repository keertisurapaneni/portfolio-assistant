import { useState, useMemo } from 'react';
import { Zap, Play, Clock, PlayCircle, AlertCircle, ChevronUp, ChevronDown, ChevronsUpDown, CheckCircle } from 'lucide-react';
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
  /** Today's trades from paper_trades — primary source of truth, driven by ib_fills trigger */
  todayTrades?: PaperTrade[];
  /** IB fills that have no matching paper_trade — shown as supplementary rows so no execution is ever missing from Today's Activity */
  orphanedFills?: import('../../../lib/paperTradesApi').OrphanedFill[];
  todaySignalsForExecute?: PendingStrategySignal[];
  onExecuteSignal?: () => void;
  ibRealizedPnl?: number | null;
  accountView?: AccountView;
}

type FilterMode = 'all' | 'day' | 'penny' | 'swing' | 'long_term' | 'options' | 'gainers' | 'losers';
type SortKey = 'ticker' | 'pnl' | 'time' | null;
type SortDir = 'asc' | 'desc';

function isTradingDay(): boolean {
  const now = new Date();
  const day = now.getDay();
  return day !== 0 && day !== 6; // 0=Sun, 6=Sat
}

export function TodayActivityTab({ events, trades, todayTrades, orphanedFills = [], todaySignalsForExecute = [], onExecuteSignal, ibRealizedPnl }: TodayActivityTabProps) {
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [executingAll, setExecutingAll] = useState(false);
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [sortKey, setSortKey] = useState<SortKey>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  // Track signals executed this session for immediate grey-out (optimistic, no refresh needed)
  const [locallyExecutedKeys, setLocallyExecutedKeys] = useState<Set<string>>(new Set());

  const todayStart = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  })();
  const todayISO = todayStart.toISOString();

  // Build the set of already-executed signal keys from todayTrades + locally tracked ones.
  // Key = ticker_signal_videoId so each influencer source is independent of auto-trader signals.
  const executedSignalKeys = useMemo(() => {
    const nonTerminal = new Set(['SUBMITTED', 'ACTIVE', 'FILLED', 'CLOSED']);
    const keys = new Set<string>(locallyExecutedKeys);
    (todayTrades ?? [])
      .filter(t => nonTerminal.has(t.status ?? '') && t.opened_at && t.opened_at >= todayISO)
      .forEach(t => {
        const vid = (t as PaperTrade & { strategy_video_id?: string | null }).strategy_video_id ?? '';
        keys.add(`${t.ticker.toUpperCase()}_${(t.signal ?? '').toUpperCase()}_${vid}`);
      });
    return keys;
  }, [todayTrades, locallyExecutedKeys, todayISO]);

  const signalKey = (s: PendingStrategySignal) =>
    `${s.ticker.toUpperCase()}_${(s.signal ?? '').toUpperCase()}_${s.strategy_video_id ?? ''}`;

  const isSignalExecuted = (s: PendingStrategySignal) => executedSignalKeys.has(signalKey(s));

  const handleExecuteSignal = async (signal: PendingStrategySignal) => {
    if (isSignalExecuted(signal)) return;
    setExecutingId(signal.id);
    try {
      const out = await executeSignal(signal.id);
      if (out.ok) {
        const executed = (out as { executed?: boolean; reason?: string }).executed;
        const reason = (out as { reason?: string }).reason;
        if (executed) {
          // Immediately grey out so re-clicking does nothing before the refresh arrives
          setLocallyExecutedKeys(prev => new Set([...prev, signalKey(signal)]));
        }
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
    // Only execute signals that haven't been executed yet — greyed-out ones are skipped
    const pending = todaySignalsForExecute.filter(s => !isSignalExecuted(s));
    if (pending.length === 0) return;
    setExecutingAll(true);
    let executed = 0;
    let skipped = 0;
    const skipReasons: string[] = [];
    for (const s of pending) {
      const out = await executeSignal(s.id);
      if (out.ok) {
        const didExec = (out as { executed?: boolean }).executed;
        const reason = (out as { reason?: string }).reason;
        if (didExec) {
          executed += 1;
          setLocallyExecutedKeys(prev => new Set([...prev, signalKey(s)]));
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
    onExecuteSignal?.();
    if (skipped > 0) {
      alert(executed > 0
        ? `${executed} executed, ${skipped} skipped:\n${skipReasons.slice(0, 5).join('\n')}${skipReasons.length > 5 ? '\n...' : ''}`
        : `All skipped:\n${skipReasons.slice(0, 5).join('\n')}${skipReasons.length > 5 ? '\n...' : ''}`);
    }
  };

  const OPTIONS_MODES = new Set(['OPTIONS_PUT', 'OPTIONS_CALL', 'CALENDAR_SPREAD', 'CREDIT_SPREAD', 'EARNINGS_CALENDAR', 'OPTIONS_SCALP', 'OPTIONS_LEAP']);

  // Primary data source: todayTrades (from paper_trades, kept accurate by ib_fills trigger).
  // Include all modes — options trades visible via the "Options" filter chip.
  // Fall back to filtering allTrades for backward compatibility.
  const primaryTradesRaw: PaperTrade[] = (todayTrades ?? trades.filter(t => {
    const openedToday = t.opened_at && t.opened_at >= todayISO;
    const closedToday = t.closed_at && t.closed_at >= todayISO;
    return openedToday || closedToday;
  })).filter(t => {
    if (t.status !== 'CANCELLED') return true;
    // Show CANCELLED trades that were placed today but never filled (submitted → EOD swept).
    // These are real activity the user needs to see (e.g. DEVS bracket order placed but
    // never triggered). Bracket TP/SL cancellations have no opened_at from today and are
    // still excluded.
    return t.close_reason === 'never_filled' && t.opened_at != null && t.opened_at >= todayISO;
  });

  // Deduplicate ib_fill_auto_created ghosts: the trigger races with recordTradeClose and
  // can create a ghost even when a real paper_trade exists (because insertIbFill fires
  // before ib_close_order_id is written). Remove ghost records when a non-ghost record
  // already exists for the same ticker. Genuine ghosts (no real trade for that ticker)
  // are kept so no execution is ever invisible.
  const tickersWithRealTrades = new Set(
    primaryTradesRaw
      .filter(t => t.close_reason !== 'ib_fill_auto_created')
      .map(t => t.ticker)
  );
  const primaryTrades: PaperTrade[] = primaryTradesRaw.filter(t =>
    t.close_reason !== 'ib_fill_auto_created' || !tickersWithRealTrades.has(t.ticker)
  );

  // Legacy lookup: events for system-only messages (reconcile warnings, orphan alerts)
  const tradesByTicker = new Map<string, PaperTrade[]>();
  for (const t of primaryTrades) {
    const arr = tradesByTicker.get(t.ticker) || [];
    arr.push(t);
    tradesByTicker.set(t.ticker, arr);
  }

  // System-only events (no mode = reconcile / orphan alerts)
  const systemEvents = events.filter(e => e.source === 'system' && !e.mode);

  if (primaryTrades.length === 0) {
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
              {todaySignalsForExecute.map((s) => {
                const alreadyDone = isSignalExecuted(s);
                return (
                  <div key={s.id} className={cn('flex items-center justify-between gap-3 px-4 py-2.5', alreadyDone && 'opacity-40')}>
                    <div className="min-w-0">
                      <span className="font-bold text-sm text-[hsl(var(--foreground))]">{s.ticker}</span>
                      <span className={cn('ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium', s.signal === 'BUY' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700')}>
                        {s.signal}
                      </span>
                      <span className="ml-1.5 text-[10px] text-[hsl(var(--muted-foreground))]">{s.mode.replace('_', ' ')}</span>
                      {s.source_name && (
                        <p className="text-[10px] text-[hsl(var(--muted-foreground))] truncate mt-0.5">{s.source_name}</p>
                      )}
                      {s.failure_reason && !alreadyDone && (
                        <p className="text-[10px] text-red-500 mt-0.5 max-w-xs truncate" title={s.failure_reason}>
                          {formatSkipReason(s.failure_reason)}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {alreadyDone ? (
                        <span className="flex items-center gap-1 text-[10px] text-emerald-600 font-medium">
                          <CheckCircle className="w-3 h-3" />
                          Executed
                        </span>
                      ) : (
                        <>
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
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  // P&L computed from closed trade records only — active (unrealized) positions are excluded
  const terminalStatusSet = new Set([...CLOSED_STATUSES, ...EXCLUDED_STATUSES] as string[]);
  const isTradeActive = (t: PaperTrade) => {
    const closed = t.close_price != null || terminalStatusSet.has(t.status) || t.closed_at != null;
    return !closed && (t.status === 'FILLED' || t.status === 'PARTIAL');
  };
  const computeTradePnl = (tradeList: PaperTrade[]) =>
    tradeList.filter(t => !isTradeActive(t)).reduce((sum, t) => sum + (t.pnl ?? 0), 0);

  // P&L from system events (e.g. IBReconcile cover buys) that carry a real pnl in metadata.
  // These are tracked via auto_trade_events (not paper_trades) so they aren't in computeTradePnl.
  // Only add to calc when showing "all" — system events are cross-mode (options cover trades).
  const systemEventsPnl = filterMode === 'all'
    ? systemEvents.reduce((sum, ev) => sum + ((ev.metadata as { pnl?: number } | null)?.pnl ?? 0), 0)
    : 0;

  const effectiveIbPnl = isTradingDay() ? ibRealizedPnl : null;

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

  const filteredSortedTrades = useMemo(() => {
    let filtered = primaryTrades;

    if (filterMode !== 'all') {
      filtered = primaryTrades.filter(t => {
        const mode = t.mode;
        if (filterMode === 'day') return mode === 'DAY_TRADE' || mode === 'DAY_PENNY';
        if (filterMode === 'penny') return mode === 'DAY_PENNY';
        if (filterMode === 'swing') return mode === 'SWING_TRADE';
        if (filterMode === 'long_term') return mode === 'LONG_TERM';
        if (filterMode === 'options') return OPTIONS_MODES.has(mode ?? '');
        if (filterMode === 'gainers') return t.pnl != null && t.pnl > 0;
        if (filterMode === 'losers') return t.pnl != null && t.pnl < 0;
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
        const closedA = a.close_price != null || terminalStatusSet.has(a.status) || a.closed_at != null;
        const closedB = b.close_price != null || terminalStatusSet.has(b.status) || b.closed_at != null;
        aVal = closedA && a.closed_at ? a.closed_at : (a.filled_at ?? a.opened_at);
        bVal = closedB && b.closed_at ? b.closed_at : (b.filled_at ?? b.opened_at);
      } else if (sortKey === 'pnl') {
        aVal = a.pnl ?? null;
        bVal = b.pnl ?? null;
      }

      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return 1;
      if (bVal === null) return -1;

      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [primaryTrades, filterMode, sortKey, sortDir]);

  const filteredPnl = useMemo(
    () => computeTradePnl(filteredSortedTrades) + systemEventsPnl,
    [filteredSortedTrades, systemEventsPnl]
  );
  const pnlLabel = filterMode === 'all' ? "Today's Realized P&L"
    : filterMode === 'day' ? 'Day Trade P&L'
    : filterMode === 'penny' ? 'Penny P&L'
    : filterMode === 'swing' ? 'Swing P&L'
    : filterMode === 'long_term' ? 'Long Term P&L'
    : filterMode === 'options' ? 'Options P&L'
    : filterMode === 'gainers' ? 'Gainers P&L'
    : 'Losers P&L';

  // Determine IB connection state for header display
  const ibConnected = isTradingDay() && ibRealizedPnl !== undefined;
  const ibSyncing = ibConnected && ibRealizedPnl === null;
  const ibOffline = !isTradingDay() || ibRealizedPnl === undefined;

  // Our calc P&L is always the primary green display; IB P&L is shown in amber as a secondary check.

  return (
    <div className="space-y-3">
      {/* Header P&L: IB realized P&L is primary when connected; paper_trades sum is secondary */}
      {filterMode === 'all' ? (
        <div className="flex items-center justify-between rounded-lg bg-[hsl(var(--secondary))] px-4 py-2.5">
          <span className="text-sm font-medium text-[hsl(var(--muted-foreground))]">{pnlLabel}</span>
          <div className="flex items-center gap-3">
            {/* Our calc P&L — always primary in green/red */}
            <span className={cn('text-sm font-bold tabular-nums', filteredPnl > 0 ? 'text-emerald-600' : filteredPnl < 0 ? 'text-red-600' : '')}>
              {fmtUsd(filteredPnl, 2, true)}
            </span>
            {/* IB P&L — amber secondary reference */}
            {effectiveIbPnl != null && (() => {
              const mismatch = Math.abs(filteredPnl - effectiveIbPnl) > 5;
              return mismatch ? (
                <span className="text-[11px] tabular-nums text-amber-500">
                  IB {fmtUsd(effectiveIbPnl, 2, true)} ⚠️
                </span>
              ) : null;
            })()}
            {ibSyncing && (
              <span className="text-[11px] text-gray-400">IB: Syncing...</span>
            )}
            {ibOffline && (
              <span className="text-[11px] text-gray-400">IB: Offline</span>
            )}
          </div>
        </div>
      ) : filteredPnl !== 0 && (
        <div className="flex items-center justify-between rounded-lg bg-[hsl(var(--secondary))] px-4 py-2.5">
          <span className="text-sm font-medium text-[hsl(var(--muted-foreground))]">{pnlLabel}</span>
          <span className={cn('text-sm font-bold tabular-nums', filteredPnl > 0 ? 'text-emerald-600' : filteredPnl < 0 ? 'text-red-600' : '')}>
            {fmtUsd(filteredPnl, 2, true)}
          </span>
        </div>
      )}

      {/* Filter + count bar */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {([
          { id: 'all',       label: 'All' },
          { id: 'day',       label: 'Day Trades' },
          { id: 'penny',     label: 'Penny' },
          { id: 'swing',     label: 'Swing' },
          { id: 'long_term', label: 'Long Term' },
          { id: 'options',   label: 'Options' },
        ] as { id: FilterMode; label: string }[]).map(f => (
          <button
            key={f.id}
            onClick={() => setFilterMode(f.id)}
            className={cn(
              'px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors',
              filterMode === f.id
                ? 'bg-[hsl(var(--foreground))] text-[hsl(var(--background))] border-[hsl(var(--foreground))]'
                : 'bg-white text-[hsl(var(--muted-foreground))] border-[hsl(var(--border))] hover:border-[hsl(var(--foreground))]/40'
            )}
          >
            {f.label}
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
            {filteredSortedTrades.length} of {primaryTrades.length}
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
            {filteredSortedTrades.map((trade) => {
              const terminalStatuses = [...CLOSED_STATUSES, ...EXCLUDED_STATUSES] as string[];
              const isClosed = trade.close_price != null
                || terminalStatuses.includes(trade.status)
                || trade.closed_at != null;
              const isActive = !isClosed && ['FILLED', 'PARTIAL'].includes(trade.status);

              // Only show realized P&L for closed trades — active positions haven't locked in gains/losses yet
              const pnl = isActive ? null : (trade.pnl ?? null);

              const isExternalSignal = !!trade.strategy_source
                || trade.scanner_reason?.includes('External')
                || trade.notes?.startsWith('External signal');
              const externalInfluencer = trade.strategy_source
                ?? trade.scanner_reason?.match(/External strategy signal from (.+?)(?:\s*\||$)/)?.[1]
                ?? null;

              // For LONG_TERM closes, surface *why* it closed (profit take / loss cut / stop)
              // alongside the category label so it's obvious at a glance.
              const isDipBuy = trade.mode === 'LONG_TERM' && trade.signal === 'BUY'
                && !!trade.notes?.toLowerCase().includes('dip buy');

              const ltCloseLabel =
                trade.close_reason === 'profit_take' || trade.close_reason === 'profit_take_50pct'
                  ? (() => {
                      const tier = trade.notes?.match(/Tier\s+(\d+)/i)?.[1];
                      const pct  = trade.notes?.match(/([\d.]+)%/)?.[1];
                      if (trade.close_reason === 'profit_take_50pct') return 'Profit Take 50%';
                      return tier && pct ? `Profit Take T${tier} (+${pct}%)` : 'Profit Take';
                    })()
                  : trade.close_reason === 'stop_loss'
                    || trade.close_reason === 'loss_cut'
                    || trade.close_reason === 'stop_loss_hit'
                    || trade.close_reason === 'stopped'
                    || trade.close_reason === 'stop_loss_100pct'
                  ? 'Loss Cut'
                  // Orphaned fills from loss cuts (ib_fill_auto_created SELL = loss cut fill)
                  : trade.close_reason === 'ib_fill_auto_created' && trade.signal === 'SELL'
                  ? 'Loss Cut'
                  : trade.close_reason === 'eod_close' || trade.close_reason === 'stale_eod_close'
                  ? 'EOD Close'
                  : trade.close_reason === 'time_exit_21dte'
                  ? '21 DTE Exit'
                  : null;

              const sourceLabel = isExternalSignal
                ? (externalInfluencer ? `External signal · ${externalInfluencer}` : 'External signal')
                : trade.mode === 'LONG_TERM'
                  ? isDipBuy
                    ? ltCloseLabel ? `Dip Buy · ${ltCloseLabel}` : 'Dip Buy'
                    : ltCloseLabel ? `Suggested find · ${ltCloseLabel}` : 'Suggested find'
                : trade.mode === 'SWING_TRADE'
                  ? ltCloseLabel ? `Swing · ${ltCloseLabel}` : 'Swing'
                : 'Trade signal';

              const modeLabel = trade.mode === 'DAY_TRADE' ? 'Day'
                : trade.mode === 'DAY_PENNY' ? 'Penny'
                : trade.mode === 'SWING_TRADE' ? 'Swing'
                : trade.mode === 'LONG_TERM' ? 'Long Term'
                : trade.mode === 'OPTIONS_SCALP' ? 'Scalp'
                : trade.mode === 'OPTIONS_LEAP' ? 'Leap'
                : trade.mode === 'OPTIONS_PUT' ? 'Put'
                : trade.mode === 'OPTIONS_CALL' ? 'Call'
                : (trade.mode === 'CREDIT_SPREAD' || trade.mode === 'CALENDAR_SPREAD' || trade.mode === 'EARNINGS_CALENDAR') ? 'Spread'
                : '—';

              const entrySignal = trade.signal ?? 'BUY';
              // Closed positions show the exit action: BUY long → SELL (sold to exit), SELL short → BUY (covered)
              const displaySignal = isClosed ? (entrySignal === 'BUY' ? 'SELL' : 'BUY') : entrySignal;
              const isSell = displaySignal === 'SELL';
              const signalColor = isSell ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700';

              const qty = trade.quantity;
              const entryPrice = trade.fill_price;
              const closePrice = trade.close_price;

              const acctType = (trade as PaperTrade & { _accountType?: 'paper' | 'live' })._accountType;

              // Stale trades: opened on a prior day but closed/reconciled today.
              // Show their original open date so the user knows this isn't a fresh trade.
              // Use opened_at < today (not close_reason) because IBLongReconcile can clear
              // close_reason when it reopens a stale position, causing the final close to
              // land with close_reason='eod_close' instead of 'stale_eod_close'.
              const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
              const isStaleClose = trade.opened_at != null
                && new Date(trade.opened_at) < todayMidnight;
              const staleOpenDate = isStaleClose
                ? new Date(trade.opened_at!).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                : null;

              return (
                <tr key={trade.id} className={cn('hover:bg-[hsl(var(--secondary))]/50', isStaleClose && 'bg-amber-50/20')}>
                  <td className="px-4 py-3 font-bold">
                    <span className="inline-flex items-center gap-1.5">
                      {acctType === 'live' && <AccountDot type="live" />}
                      {trade.ticker}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn('inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold', signalColor)}>
                      {displaySignal}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-slate-100 text-slate-600">
                      {modeLabel}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-[hsl(var(--muted-foreground))]">
                    <span className="font-medium text-[hsl(var(--foreground))]">{sourceLabel}</span>
                    {qty != null && entryPrice != null && (
                      <span> · {qty} shares @ ${entryPrice.toFixed(2)}</span>
                    )}
                    {closePrice != null && (
                      <span className="ml-1 text-[10px]">→ ${closePrice.toFixed(2)}</span>
                    )}
                    {isStaleClose && staleOpenDate && (
                      <span className="ml-1.5 px-1 py-0.5 rounded text-[9px] font-medium bg-amber-100 text-amber-700" title="Trade opened on a prior day — cleaned up today by stale EOD close">
                        opened {staleOpenDate}
                      </span>
                    )}
                    {trade.strategy_video_heading && (
                      <p className="text-[10px] text-[hsl(var(--muted-foreground))] truncate max-w-[180px] mt-0.5" title={trade.strategy_video_heading}>
                        {trade.strategy_video_heading}
                      </p>
                    )}
                  </td>
                  <td className={cn(
                    'px-4 py-3 text-right tabular-nums font-semibold',
                    pnl != null && pnl > 0 ? 'text-emerald-600' : pnl != null && pnl < 0 ? 'text-red-600' : ''
                  )}>
                    {pnl != null ? fmtUsd(pnl, 2, true) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {trade.status === 'CANCELLED' && trade.close_reason === 'never_filled' ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-medium">Never filled</span>
                    ) : isClosed ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-medium">Closed</span>
                    ) : isActive ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 font-medium">Active</span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 font-medium">Pending</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-[hsl(var(--muted-foreground))] tabular-nums">
                    {new Date(isClosed && trade.closed_at ? trade.closed_at : (trade.filled_at ?? trade.opened_at)).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  </td>
                </tr>
              );
            })}
            {/* Orphaned IB fills — executions that had no matching paper_trade.
                These are auto-detected from ib_fills so no execution is ever
                invisible in Today's Activity, regardless of tracking gaps. */}
            {orphanedFills.map((fill) => {
              const pnl = fill.realized_pnl;
              return (
                <tr key={fill._id} className="bg-amber-50/30 hover:bg-amber-50/60">
                  <td className="px-4 py-3 font-bold">
                    <span className="inline-flex items-center gap-1.5">
                      {fill.ticker}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-600">—</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-amber-100 text-amber-700">IB Fill</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-[hsl(var(--muted-foreground))]">
                    <span className="font-medium text-[hsl(var(--foreground))]">System · IB execution</span>
                    <span> · {fill.total_quantity} shares @ ${fill.avg_fill_price.toFixed(2)}</span>
                  </td>
                  <td className={cn(
                    'px-4 py-3 text-right tabular-nums font-semibold',
                    pnl != null && pnl > 0 ? 'text-emerald-600' : pnl != null && pnl < 0 ? 'text-red-600' : ''
                  )}>
                    {pnl != null ? fmtUsd(pnl, 2, true) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-medium">Closed</span>
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-[hsl(var(--muted-foreground))] tabular-nums">
                    {new Date(fill.filled_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  </td>
                </tr>
              );
            })}
            {/* System/reconcile events shown as supplementary rows (e.g. IBReconcile cover buys) */}
            {systemEvents.map((ev) => {
              const evPnl = (ev.metadata as { pnl?: number } | null)?.pnl ?? null;
              return (
                <tr key={ev.id} className="hover:bg-[hsl(var(--secondary))]/50">
                  <td className="px-4 py-3 font-bold">
                    <span className="inline-flex items-center gap-1.5">
                      {ev.ticker}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-600">—</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-purple-50 text-purple-600">System</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-[hsl(var(--muted-foreground))]">
                    <span className="font-medium text-[hsl(var(--foreground))]">System</span>
                    <span> · {ev.message?.slice(0, 60)}</span>
                  </td>
                  <td className={cn(
                    'px-4 py-3 text-right tabular-nums font-semibold',
                    evPnl != null && evPnl > 0 ? 'text-emerald-600' : evPnl != null && evPnl < 0 ? 'text-red-600' : ''
                  )}>
                    {evPnl != null ? fmtUsd(evPnl, 2, true) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-medium">Closed</span>
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-[hsl(var(--muted-foreground))] tabular-nums">
                    {new Date(ev.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
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
            {todaySignalsForExecute.map((s) => {
              const alreadyDone = isSignalExecuted(s);
              return (
                <div key={s.id} className={cn('flex items-center justify-between gap-3 px-4 py-2.5', alreadyDone && 'opacity-40')}>
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
                    {alreadyDone ? (
                      <span className="flex items-center gap-1 text-[10px] text-emerald-600 font-medium">
                        <CheckCircle className="w-3 h-3" />
                        Executed
                      </span>
                    ) : (
                      <>
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
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

    </div>
  );
}
