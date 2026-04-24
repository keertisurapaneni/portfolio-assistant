import { useState, useEffect } from 'react';
import { Zap, Play, Clock, PlayCircle, AlertCircle } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { AutoTradeEventRecord, PaperTrade, PendingStrategySignal } from '../../../lib/paperTradesApi';
import { executeSignal } from '../../../lib/paperTradesApi';
import { fmtUsd } from '../utils';
import { supabase } from '../../../lib/supabaseClient';

// ── Options Wheel section ─────────────────────────────────

interface OptionsTrade {
  id: string;
  ticker: string;
  mode: string;
  scanner_signal: string | null;
  status: string;
  pnl: number | null;
  close_reason: string | null;
  option_premium: number | null;
  option_contracts: number | null;
  opened_at: string | null;
  closed_at: string | null;
  notes: string | null;
}

function optionsActionLabel(trade: OptionsTrade): { label: string; color: string } {
  if (trade.close_reason === '50pct_profit') return { label: 'Closed 50%', color: 'bg-emerald-100 text-emerald-700' };
  if (trade.close_reason === 'rolled') return { label: 'Rolled', color: 'bg-blue-100 text-blue-700' };
  if (trade.close_reason === 'stop_loss' || trade.status === 'STOPPED') return { label: 'Stop-loss', color: 'bg-red-100 text-red-700' };
  if (trade.close_reason === 'expired_worthless') return { label: 'Expired', color: 'bg-emerald-100 text-emerald-700' };
  if (trade.close_reason === '21dte_profit' || trade.close_reason === '21dte_close') return { label: '21 DTE Close', color: 'bg-emerald-100 text-emerald-700' };
  if (trade.closed_at) return { label: 'Closed', color: 'bg-slate-100 text-slate-600' };
  return { label: 'Opened', color: 'bg-blue-100 text-blue-700' };
}

function OptionsWheelSection({ todayStart }: { todayStart: Date }) {
  const [trades, setTrades] = useState<OptionsTrade[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchOptionsTrades() {
      setLoading(true);
      try {
        const [{ data: opened }, { data: closed }] = await Promise.all([
          supabase
            .from('paper_trades')
            .select('id, ticker, mode, scanner_signal, status, pnl, close_reason, option_premium, option_contracts, opened_at, closed_at, notes')
            .in('mode', ['OPTIONS_PUT', 'OPTIONS_CALL'])
            .gte('opened_at', todayStart.toISOString())
            .order('opened_at', { ascending: false }),
          supabase
            .from('paper_trades')
            .select('id, ticker, mode, scanner_signal, status, pnl, close_reason, option_premium, option_contracts, opened_at, closed_at, notes')
            .in('mode', ['OPTIONS_PUT', 'OPTIONS_CALL'])
            .not('closed_at', 'is', null)
            .gte('closed_at', todayStart.toISOString()),
        ]);

        // Merge by id — closed version takes precedence (has close info)
        const merged = new Map<string, OptionsTrade>();
        for (const t of (opened ?? [])) merged.set(t.id, t as OptionsTrade);
        for (const t of (closed ?? [])) merged.set(t.id, t as OptionsTrade);

        const sorted = [...merged.values()].sort((a, b) => {
          const aTime = a.closed_at ?? a.opened_at ?? '';
          const bTime = b.closed_at ?? b.opened_at ?? '';
          return bTime.localeCompare(aTime);
        });
        setTrades(sorted);
      } catch (err) {
        console.error('Options trades fetch error:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchOptionsTrades();
  }, [todayStart]);

  const premiumTotal = trades.reduce((s, t) => s + (t.option_premium ?? 0) * (t.option_contracts ?? 1) * 100, 0);
  const pnlTotal = trades.filter(t => t.pnl != null).reduce((s, t) => s + (t.pnl ?? 0), 0);

  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
      <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[hsl(var(--foreground))]">Options Wheel</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 font-bold">
            {loading ? '…' : trades.length}
          </span>
        </div>
        {trades.length > 0 && (
          <div className="flex items-center gap-3 text-[10px] text-[hsl(var(--muted-foreground))]">
            {premiumTotal > 0 && (
              <span>Premium: <span className="font-semibold text-emerald-600">+${premiumTotal.toFixed(0)}</span></span>
            )}
            {pnlTotal !== 0 && (
              <span>P&L: <span className={cn('font-semibold', pnlTotal > 0 ? 'text-emerald-600' : 'text-red-600')}>{fmtUsd(pnlTotal, 0, true)}</span></span>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <div className="px-4 py-5 text-center text-xs text-[hsl(var(--muted-foreground))]">Loading…</div>
      ) : trades.length === 0 ? (
        <div className="px-4 py-5 text-center text-xs text-[hsl(var(--muted-foreground))] opacity-60">
          No options activity today
        </div>
      ) : (
        <div className="divide-y divide-[hsl(var(--border))]">
          {trades.map(trade => {
            const { label: actionLabel, color: actionColor } = optionsActionLabel(trade);
            const premium = (trade.option_premium ?? 0) * (trade.option_contracts ?? 1) * 100;
            // Prefer filled_at (IB execution time) for active trades so the time shown
            // reflects when the order actually filled, not when the DB record was created.
            // OptionsTrade does not have filled_at, so cast via unknown to avoid TS error.
            const filledAt = (trade as unknown as { filled_at?: string }).filled_at;
            const timeStr = new Date(trade.closed_at ?? filledAt ?? trade.opened_at ?? '').toLocaleTimeString(
              undefined,
              { hour: '2-digit', minute: '2-digit' }
            );
            const isOpen = !trade.closed_at;
            const pnlColor = trade.pnl != null && trade.pnl > 0 ? 'text-emerald-600'
              : trade.pnl != null && trade.pnl < 0 ? 'text-red-600'
              : 'text-[hsl(var(--muted-foreground))]';

            return (
              <div key={trade.id} className={cn(
                'flex items-center gap-3 px-4 py-2.5',
                isOpen && 'bg-blue-50/30',
              )}>
                {/* Ticker + mode badge */}
                <div className="flex items-center gap-1.5 w-24 shrink-0">
                  <span className="text-sm font-bold text-[hsl(var(--foreground))]">{trade.ticker}</span>
                  <span className={cn(
                    'text-[10px] px-1 py-0.5 rounded font-medium',
                    trade.mode === 'OPTIONS_CALL' ? 'bg-blue-100 text-blue-700' : 'bg-violet-100 text-violet-700'
                  )}>
                    {trade.mode === 'OPTIONS_CALL' ? 'CALL' : 'PUT'}
                  </span>
                </div>

                {/* Action */}
                <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-semibold shrink-0', actionColor)}>
                  {actionLabel}
                </span>

                {/* Premium collected */}
                <span className="text-xs text-emerald-600 font-medium tabular-nums shrink-0">
                  {premium > 0 ? `+$${premium.toFixed(0)}` : '—'}
                </span>

                {/* P&L */}
                <span className={cn('text-xs font-semibold tabular-nums shrink-0', pnlColor)}>
                  {trade.pnl != null ? fmtUsd(trade.pnl, 0, true) : '—'}
                </span>

                {/* Spacer */}
                <div className="flex-1 min-w-0" />

                {/* Time */}
                <span className="text-[10px] text-[hsl(var(--muted-foreground))] tabular-nums shrink-0">
                  {timeStr}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

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

export interface TodayActivityTabProps {
  events: AutoTradeEventRecord[];
  trades: PaperTrade[];
  todaySignalsForExecute?: PendingStrategySignal[];
  onExecuteSignal?: () => void;
}

export function TodayActivityTab({ events, trades, todaySignalsForExecute = [], onExecuteSignal }: TodayActivityTabProps) {
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [executingAll, setExecutingAll] = useState(false);
  const [scannerTickers, setScannerTickers] = useState<Set<string>>(new Set());

  const todayStart = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  })();

  // Load today's trade scan tickers from DB to correctly attribute source
  useEffect(() => {
    supabase
      .from('trade_scans')
      .select('data')
      .in('id', ['day_trades', 'swing_trades'])
      .then(({ data }) => {
        if (!data) return;
        const tickers = new Set<string>();
        for (const row of data) {
          const ideas = row.data as Array<{ ticker: string }> | null;
          if (Array.isArray(ideas)) {
            ideas.forEach(i => { if (i.ticker) tickers.add(i.ticker.toUpperCase()); });
          }
        }
        setScannerTickers(tickers);
      });
  }, []);

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

        <OptionsWheelSection todayStart={todayStart} />

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
              // Signal generators pick their own tickers with their own entry/exit levels.
              // Even if our scanner also has the ticker, it's coincidental — don't conflate.
              // EXCEPTION: if the signal is from a stale video (heading references a different
              // date), treat it like an execution strategy and fall back to scannerTickers.
              const SIGNAL_GENERATORS = new Set([
                'Somesh | Day Trader | Investor',
                'Kay Capitals',
              ]);
              // Execution strategies apply rules ON TOP of our scanner signals.
              // Their tickers come from us — should show as "Trade signal + [strategy]".
              const EXECUTION_STRATEGIES = new Set([
                'Casper Clipping',
                'Casper SMC Wisdom',
              ]);
              const stratSource = event.strategy_source ?? '';

              // Detect stale rescheduled videos — heading must contain today's date (e.g. "April 22")
              const todayMonths = ['january','february','march','april','may','june','july','august','september','october','november','december'];
              const todayMonth = todayMonths[new Date().getMonth()];
              const todayDay = new Date().getDate().toString();
              const heading = (event.strategy_video_heading ?? '').toLowerCase();
              const isFromTodayVideo = !heading || (heading.includes(todayMonth) && heading.includes(todayDay));

              const isPureExternal = SIGNAL_GENERATORS.has(stratSource) && isFromTodayVideo;
              const isExecutionStrategy = EXECUTION_STRATEGIES.has(stratSource);
              const isOurScan = event.source === 'scanner'
                || (!isPureExternal && (isExecutionStrategy || scannerTickers.has(event.ticker.toUpperCase())));
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
              // Match "7 shares @ $675" OR "BUY 7 @ $675" (external signal format)
              const sharesMatch = msg.match(/(\d+)\s+shares.*?@\s*~?\$?([\d.]+)/i);
              const externalMatch = msg.match(/(?:BUY|SELL)\s+(\d+)\s+@\s*~?\$?([\d.]+)/i);
              const qtyMatch = sharesMatch ?? externalMatch;

              const sourceLabel = event.source === 'scanner' ? 'Trade signal'
                : (event.source === 'external_signal' && isOurScan)
                  ? (event.strategy_source ? `Trade signal + ${event.strategy_source}` : 'Trade signal + External')
                : event.source === 'external_signal' ? 'External signal'
                : event.source === 'suggested_finds' ? 'Suggested find'
                : event.source === 'dip_buy' ? 'Dip buy'
                : event.source === 'profit_take' ? 'Profit take'
                : event.source === 'loss_cut' ? 'Loss cut'
                : event.source === 'system' ? 'System'
                : event.source === 'manual' ? 'Manual'
                : 'Trade';

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
                    <span className="font-medium text-[hsl(var(--foreground))]">{sourceLabel}</span>
                    {event.strategy_source && (event.source !== 'scanner') && (!isOurScan || isPureExternal) && (
                      <span className="ml-1 px-1 py-0.5 rounded text-[10px] font-semibold bg-indigo-50 text-indigo-600 border border-indigo-200">
                        {event.strategy_source}
                      </span>
                    )}
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

      <OptionsWheelSection todayStart={todayStart} />
    </div>
  );
}
