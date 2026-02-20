import { useState } from 'react';
import { Clock } from 'lucide-react';
import type { PaperTrade, PendingStrategySignal } from '../../../lib/paperTradesApi';
import { fmtUsd } from '../utils';
import { StatusBadge } from '../shared';

type HistorySortKey = 'date' | 'ticker' | 'pnl' | 'signal' | 'status';

export interface HistoryTabProps {
  trades: PaperTrade[];
  pendingSignals: PendingStrategySignal[];
}

export function HistoryTab({ trades, pendingSignals }: HistoryTabProps) {
  const [sortKey, setSortKey] = useState<HistorySortKey>('date');
  const [sortAsc, setSortAsc] = useState(false);

  if (trades.length === 0 && pendingSignals.length === 0) {
    return (
      <div className="text-center py-12">
        <Clock className="w-10 h-10 text-[hsl(var(--muted-foreground))] opacity-40 mx-auto" />
        <p className="mt-3 text-sm text-[hsl(var(--muted-foreground))]">No trades or pending strategy signals yet</p>
      </div>
    );
  }

  const sorted = [...trades].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case 'date': cmp = new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime(); break;
      case 'ticker': cmp = a.ticker.localeCompare(b.ticker); break;
      case 'pnl': cmp = (a.pnl ?? 0) - (b.pnl ?? 0); break;
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

  const activeTrades = trades.filter(t => ['SUBMITTED', 'FILLED', 'PARTIAL', 'PENDING'].includes(t.status));
  const totalPendingLike = activeTrades.length + pendingSignals.length;
  const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const wins = trades.filter(t => (t.pnl ?? 0) > 0).length;
  const losses = trades.filter(t => (t.pnl ?? 0) < 0).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-lg bg-[hsl(var(--secondary))] px-4 py-2.5">
        <div className="flex items-center gap-4 text-xs text-[hsl(var(--muted-foreground))]">
          <span>{trades.length} trades</span>
          {totalPendingLike > 0 && (
            <span className="text-blue-600">{totalPendingLike} active/pending</span>
          )}
          {pendingSignals.length > 0 && <span className="text-amber-600">{pendingSignals.length} strategy signals pending</span>}
          <span className="text-emerald-600">{wins}W</span>
          <span className="text-red-500">{losses}L</span>
        </div>
        <span className={`text-sm font-bold tabular-nums ${totalPnl > 0 ? 'text-emerald-600' : totalPnl < 0 ? 'text-red-600' : ''}`}>
          Total: {fmtUsd(totalPnl, 2, true)}
        </span>
      </div>

      {pendingSignals.length > 0 && (
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
              {pendingSignals.map(signal => (
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
              return (
                <tr key={trade.id} className={`hover:bg-[hsl(var(--secondary))]/50 ${isActive ? 'bg-blue-50/30' : ''}`}>
                  <td className="px-4 py-3 font-bold">{trade.ticker}</td>
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
                  <td className={`px-4 py-3 text-right tabular-nums font-semibold ${(trade.pnl ?? 0) > 0 ? 'text-emerald-600' : (trade.pnl ?? 0) < 0 ? 'text-red-600' : ''}`}>
                    {trade.pnl != null ? fmtUsd(trade.pnl, 2, true) : '—'}
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
      </div>
    </div>
  );
}
