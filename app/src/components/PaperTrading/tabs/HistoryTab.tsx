import { useMemo, useState } from 'react';
import { Clock, Search, X } from 'lucide-react';
import type { PaperTrade, PendingStrategySignal } from '../../../lib/paperTradesApi';
import type { AccountView } from '../../../contexts/AccountContext';
import { cn } from '../../../lib/utils';
import { fmtUsd } from '../utils';
import { StatusBadge } from '../shared';

type HistorySortKey = 'date' | 'ticker' | 'pnl' | 'signal' | 'status';

function AccountDot({ type }: { type?: 'paper' | 'live' }) {
  if (!type) return null;
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${type === 'live' ? 'bg-emerald-500' : 'bg-slate-400'}`}
      title={type === 'live' ? 'Live trade' : 'Paper trade'}
    />
  );
}

/** Confirmed P&L only — same rule as the W/L summary (requires pnl_source). */
function confirmedPnl(t: PaperTrade): number | null {
  return t.pnl_source != null ? t.pnl : null;
}

export interface HistoryTabProps {
  trades: PaperTrade[];
  pendingSignals: PendingStrategySignal[];
  accountView?: AccountView;
}

export function HistoryTab({ trades, pendingSignals, accountView }: HistoryTabProps) {
  const [sortKey, setSortKey] = useState<HistorySortKey>('date');
  const [sortAsc, setSortAsc] = useState(false);
  const [tickerQuery, setTickerQuery] = useState('');
  const [hasPnlOnly, setHasPnlOnly] = useState(false);

  const tickerNormalized = tickerQuery.trim().toUpperCase();
  const filtersActive = tickerNormalized.length > 0 || hasPnlOnly;

  const filteredTrades = useMemo(() => {
    return trades.filter(t => {
      if (tickerNormalized && !t.ticker.toUpperCase().includes(tickerNormalized)) return false;
      if (hasPnlOnly && confirmedPnl(t) == null) return false;
      return true;
    });
  }, [trades, tickerNormalized, hasPnlOnly]);

  const filteredPending = useMemo(() => {
    if (!tickerNormalized) return pendingSignals;
    return pendingSignals.filter(s => s.ticker.toUpperCase().includes(tickerNormalized));
  }, [pendingSignals, tickerNormalized]);

  if (trades.length === 0 && pendingSignals.length === 0) {
    return (
      <div className="text-center py-12">
        <Clock className="w-10 h-10 text-[hsl(var(--muted-foreground))] opacity-40 mx-auto" />
        <p className="mt-3 text-sm text-[hsl(var(--muted-foreground))]">No trades or pending strategy signals yet</p>
      </div>
    );
  }

  const sorted = [...filteredTrades].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case 'date': cmp = new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime(); break;
      case 'ticker': cmp = a.ticker.localeCompare(b.ticker); break;
      case 'pnl': {
        const aPnl = confirmedPnl(a) ?? -Infinity;
        const bPnl = confirmedPnl(b) ?? -Infinity;
        cmp = aPnl - bPnl;
        break;
      }
      case 'signal': cmp = (a.signal ?? '').localeCompare(b.signal ?? ''); break;
      case 'status': cmp = (a.status ?? '').localeCompare(b.status ?? ''); break;
    }
    return sortAsc ? cmp : -cmp;
  });

  const handleSort = (key: HistorySortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(key === 'ticker'); }
  };

  const SortHeader = ({ label, col, align = 'left' }: { label: string; col: HistorySortKey; align?: 'left' | 'right' }) => (
    <th
      className={`px-4 py-2.5 font-medium cursor-pointer select-none hover:text-[hsl(var(--foreground))] transition-colors ${align === 'right' ? 'text-right' : 'text-left'}`}
      onClick={() => handleSort(col)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortKey === col ? (
          <span className="text-[10px]">{sortAsc ? '▲' : '▼'}</span>
        ) : (
          <span className="text-[10px] opacity-30">⇅</span>
        )}
      </span>
    </th>
  );

  const activeTrades = filteredTrades.filter(t => ['SUBMITTED', 'FILLED', 'PARTIAL', 'PENDING'].includes(t.status));
  const totalPendingLike = activeTrades.length + filteredPending.length;
  const tradesWithPnl = filteredTrades.filter(t => confirmedPnl(t) != null);
  const totalPnl = tradesWithPnl.reduce((s, t) => s + confirmedPnl(t)!, 0);
  const wins = tradesWithPnl.filter(t => confirmedPnl(t)! > 0).length;
  const losses = tradesWithPnl.filter(t => confirmedPnl(t)! < 0).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-lg bg-[hsl(var(--secondary))] px-4 py-2.5">
        <div className="flex items-center gap-4 text-xs text-[hsl(var(--muted-foreground))]">
          <span>
            {filtersActive
              ? `${filteredTrades.length} of ${trades.length} trades`
              : `${trades.length} trades`}
          </span>
          {totalPendingLike > 0 && (
            <span className="text-blue-600">{totalPendingLike} active/pending</span>
          )}
          {filteredPending.length > 0 && (
            <span className="text-amber-600">{filteredPending.length} strategy signals pending</span>
          )}
          <span className="text-emerald-600">{wins}W</span>
          <span className="text-red-500">{losses}L</span>
        </div>
        <span className={`text-sm font-bold tabular-nums ${totalPnl > 0 ? 'text-emerald-600' : totalPnl < 0 ? 'text-red-600' : ''}`}>
          Total: {fmtUsd(totalPnl, 2, true)}
        </span>
      </div>

      {/* Search + filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />
          <input
            type="text"
            value={tickerQuery}
            onChange={e => setTickerQuery(e.target.value)}
            placeholder="Search ticker…"
            className="h-8 w-36 pl-8 pr-7 text-xs rounded-md border border-[hsl(var(--border))] bg-white text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:ring-1 focus:ring-[hsl(var(--foreground))]/20 uppercase"
            spellCheck={false}
            autoComplete="off"
          />
          {tickerQuery && (
            <button
              type="button"
              onClick={() => setTickerQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
              aria-label="Clear ticker search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setHasPnlOnly(v => !v)}
          className={cn(
            'px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors',
            hasPnlOnly
              ? 'bg-[hsl(var(--foreground))] text-[hsl(var(--background))] border-[hsl(var(--foreground))]'
              : 'bg-white text-[hsl(var(--muted-foreground))] border-[hsl(var(--border))] hover:border-[hsl(var(--foreground))]/40'
          )}
        >
          Has P&L
        </button>
        {filtersActive && (
          <button
            type="button"
            onClick={() => { setTickerQuery(''); setHasPnlOnly(false); }}
            className="text-[10px] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] underline-offset-2 hover:underline"
          >
            Clear
          </button>
        )}
      </div>

      {filteredPending.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/40 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-amber-200/60 bg-amber-50">
            <h3 className="text-sm font-semibold text-amber-800">Pending Strategy Signals</h3>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-amber-50/80 text-amber-700 text-xs">
                <th className="text-left px-4 py-2.5 font-medium">Ticker</th>
                <th className="text-left px-4 py-2.5 font-medium">Signal</th>
                <th className="text-left px-4 py-2.5 font-medium">Strategy</th>
                <th className="text-right px-4 py-2.5 font-medium">Entry Trigger</th>
                <th className="text-right px-4 py-2.5 font-medium">Applicable Date</th>
                <th className="text-left px-4 py-2.5 font-medium">Source</th>
                <th className="text-left px-4 py-2.5 font-medium">Status</th>
                <th className="text-right px-4 py-2.5 font-medium">Added</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-amber-200/60">
              {filteredPending.map(signal => (
                <tr key={signal.id} className="hover:bg-amber-50/80">
                  <td className="px-4 py-3 font-bold">{signal.ticker}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold ${signal.signal === 'BUY' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                      {signal.signal}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <div className="min-w-0">
                      <p className="truncate text-[hsl(var(--foreground))]">
                        {signal.strategy_video_heading ?? signal.strategy_video_id ?? 'External strategy'}
                      </p>
                      {signal.strategy_video_id && (
                        <a
                          href={`https://www.instagram.com/reel/${signal.strategy_video_id}/`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[10px] text-blue-600 hover:text-blue-700"
                        >
                          Open video
                        </a>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {signal.entry_price != null ? `$${signal.entry_price.toFixed(2)}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{signal.execute_on_date}</td>
                  <td className="px-4 py-3 text-xs text-[hsl(var(--muted-foreground))]">
                    {signal.source_name}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={signal.status} />
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-[hsl(var(--muted-foreground))] tabular-nums">
                    {new Date(signal.created_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
        {sorted.length === 0 ? (
          <div className="text-center py-10 px-4">
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              No trades match{tickerNormalized ? ` “${tickerNormalized}”` : ''}
              {hasPnlOnly ? ' with confirmed P&L' : ''}
            </p>
            <button
              type="button"
              onClick={() => { setTickerQuery(''); setHasPnlOnly(false); }}
              className="mt-2 text-xs text-blue-600 hover:text-blue-700"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))] text-xs">
                <SortHeader label="Ticker" col="ticker" />
                <SortHeader label="Signal" col="signal" />
                <th className="text-right px-4 py-2.5 font-medium">Shares</th>
                <th className="text-right px-4 py-2.5 font-medium">Entry</th>
                <th className="text-right px-4 py-2.5 font-medium">Close</th>
                <SortHeader label="P&L" col="pnl" align="right" />
                <SortHeader label="Result" col="status" />
                <th className="text-left px-4 py-2.5 font-medium">Reason</th>
                <SortHeader label="Date" col="date" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[hsl(var(--border))]">
              {sorted.map(trade => {
                const isActive = ['SUBMITTED', 'FILLED', 'PARTIAL', 'PENDING'].includes(trade.status);
                const pnl = confirmedPnl(trade);
                return (
                  <tr key={trade.id} className={`hover:bg-[hsl(var(--secondary))]/50 ${isActive ? 'bg-blue-50/30' : ''}`}>
                    <td className="px-4 py-3 font-bold">
                      <span className="inline-flex items-center gap-1.5">
                        {accountView === 'live' && <AccountDot type="live" />}
                        {trade.ticker}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold ${trade.signal === 'BUY' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                        {trade.signal}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-[hsl(var(--muted-foreground))]">
                      {trade.quantity != null ? trade.quantity.toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      ${trade.fill_price?.toFixed(2) ?? trade.entry_price?.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {trade.close_price ? `$${trade.close_price.toFixed(2)}` : '—'}
                    </td>
                    <td className={`px-4 py-3 text-right tabular-nums font-semibold ${pnl != null && pnl > 0 ? 'text-emerald-600' : pnl != null && pnl < 0 ? 'text-red-600' : ''}`}>
                      {pnl != null ? fmtUsd(pnl, 2, true) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={trade.status} />
                    </td>
                    <td className="px-4 py-3 text-xs text-[hsl(var(--muted-foreground))]">
                      {trade.close_reason ?? (isActive ? trade.mode?.replace('_', ' ').toLowerCase() : '—')}
                    </td>
                    <td className="px-4 py-3 text-xs text-[hsl(var(--muted-foreground))] tabular-nums">
                      {new Date(trade.opened_at).toLocaleDateString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
