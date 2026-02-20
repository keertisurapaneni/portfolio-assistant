import { useState } from 'react';
import {
  Briefcase,
  WifiOff,
  ArrowUpDown,
  ChevronUp,
  ChevronDown,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
} from 'lucide-react';
import type { IBPosition, IBLiveOrder } from '../../../lib/ibClient';
import type { PendingStrategySignal } from '../../../lib/paperTradesApi';
import { fmtUsd } from '../utils';
import { StatusBadge } from '../shared';

type PortfolioSortKey = 'symbol' | 'shares' | 'avgCost' | 'costBasis' | 'mktPrice' | 'mktValue' | 'pnl' | 'pnlPct';
type SortDir = 'asc' | 'desc';

function getPortfolioSortValue(pos: IBPosition, key: PortfolioSortKey): number | string {
  switch (key) {
    case 'symbol': return pos.contractDesc;
    case 'shares': return Math.abs(pos.position);
    case 'avgCost': return pos.avgCost;
    case 'costBasis': return Math.abs(pos.position) * pos.avgCost;
    case 'mktPrice': return pos.mktPrice;
    case 'mktValue': return Math.abs(pos.mktValue);
    case 'pnl': return pos.unrealizedPnl;
    case 'pnlPct': {
      const cost = Math.abs(pos.position) * pos.avgCost;
      return cost > 0 ? (pos.unrealizedPnl / cost) * 100 : 0;
    }
    default: return 0;
  }
}

export interface PortfolioTabProps {
  positions: IBPosition[];
  orders: IBLiveOrder[];
  pendingSignals: PendingStrategySignal[];
  connected: boolean;
  onRefresh: () => void;
}

export function PortfolioTab({ positions, orders, pendingSignals, connected, onRefresh }: PortfolioTabProps) {
  const [sortKey, setSortKey] = useState<PortfolioSortKey>('costBasis');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const handleSort = (key: PortfolioSortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'symbol' ? 'asc' : 'desc');
    }
  };

  const SortIcon = ({ col }: { col: PortfolioSortKey }) => {
    if (sortKey !== col) return <ArrowUpDown className="w-3 h-3 opacity-30" />;
    return sortDir === 'asc'
      ? <ChevronUp className="w-3 h-3 text-blue-600" />
      : <ChevronDown className="w-3 h-3 text-blue-600" />;
  };

  const SortHeader = ({ col, label, align = 'right' }: { col: PortfolioSortKey; label: string; align?: 'left' | 'right' }) => (
    <th className={`px-4 py-2.5 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        onClick={() => handleSort(col)}
        className={`inline-flex items-center gap-1 hover:text-[hsl(var(--foreground))] transition-colors ${sortKey === col ? 'text-blue-600 font-semibold' : ''}`}
      >
        {align === 'right' && <SortIcon col={col} />}
        {label}
        {align === 'left' && <SortIcon col={col} />}
      </button>
    </th>
  );

  if (!connected) {
    return (
      <div className="text-center py-12">
        <WifiOff className="w-10 h-10 text-[hsl(var(--muted-foreground))] opacity-40 mx-auto" />
        <p className="mt-3 text-sm text-[hsl(var(--muted-foreground))]">IB Gateway not connected</p>
        <p className="text-xs text-[hsl(var(--muted-foreground))] opacity-70 mt-1">
          Start the auto-trader service to see your portfolio
        </p>
      </div>
    );
  }

  const totalCostBasis = positions.reduce((sum, p) => sum + Math.abs(p.position) * p.avgCost, 0);
  const totalMktValue = positions.reduce((sum, p) => sum + p.mktValue, 0);
  const totalUnrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

  const sorted = [...positions].sort((a, b) => {
    const aVal = getPortfolioSortValue(a, sortKey);
    const bVal = getPortfolioSortValue(b, sortKey);
    const cmp = typeof aVal === 'string' && typeof bVal === 'string'
      ? aVal.localeCompare(bVal)
      : (aVal as number) - (bVal as number);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  return (
    <div className="space-y-4">
      {positions.length > 0 ? (
        <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))] flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">Positions</h3>
            <button onClick={onRefresh} className="text-xs text-blue-600 hover:text-blue-700 font-medium">
              Refresh
            </button>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[hsl(var(--secondary))]/50 text-[hsl(var(--muted-foreground))] text-xs">
                <SortHeader col="symbol" label="Symbol" align="left" />
                <SortHeader col="shares" label="Shares" />
                <SortHeader col="avgCost" label="Avg Cost" />
                <SortHeader col="costBasis" label="Cost Basis" />
                <SortHeader col="mktPrice" label="Mkt Price" />
                <SortHeader col="mktValue" label="Mkt Value" />
                <SortHeader col="pnl" label="P&L" />
                <SortHeader col="pnlPct" label="P&L %" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[hsl(var(--border))]">
              {sorted.map((pos, i) => {
                const costBasis = Math.abs(pos.position) * pos.avgCost;
                const pnl = pos.unrealizedPnl;
                const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
                const hasMktData = pos.mktPrice > 0;
                return (
                  <tr key={`${pos.conid}-${i}`} className="hover:bg-[hsl(var(--secondary))]/50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-bold">{pos.contractDesc}</span>
                        <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold ${pos.position > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                          {pos.position > 0 ? 'LONG' : 'SHORT'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium">{Math.abs(pos.position)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">${pos.avgCost.toFixed(2)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">${costBasis.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {hasMktData ? `$${pos.mktPrice.toFixed(2)}` : <span className="text-[hsl(var(--muted-foreground))] opacity-50">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {hasMktData ? `$${pos.mktValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : <span className="text-[hsl(var(--muted-foreground))] opacity-50">—</span>}
                    </td>
                    <td className={`px-4 py-3 text-right tabular-nums font-semibold ${pnl > 0 ? 'text-emerald-600' : pnl < 0 ? 'text-red-600' : ''}`}>
                      {hasMktData ? (
                        <span className="flex items-center justify-end gap-1">
                          {pnl > 0 ? <TrendingUp className="w-3 h-3" /> : pnl < 0 ? <TrendingDown className="w-3 h-3" /> : null}
                          {fmtUsd(pnl, 2, true)}
                        </span>
                      ) : <span className="text-[hsl(var(--muted-foreground))] opacity-50">—</span>}
                    </td>
                    <td className={`px-4 py-3 text-right tabular-nums text-xs font-medium ${pnlPct > 0 ? 'text-emerald-600' : pnlPct < 0 ? 'text-red-600' : ''}`}>
                      {hasMktData ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : <span className="text-[hsl(var(--muted-foreground))] opacity-50">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {totalMktValue > 0 && (
              <tfoot>
                <tr className="bg-[hsl(var(--secondary))]/70 font-semibold text-sm">
                  <td className="px-4 py-2.5" colSpan={3}>Total</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">${totalCostBasis.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  <td className="px-4 py-2.5" />
                  <td className="px-4 py-2.5 text-right tabular-nums">${totalMktValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  <td className={`px-4 py-2.5 text-right tabular-nums ${totalUnrealizedPnl > 0 ? 'text-emerald-600' : totalUnrealizedPnl < 0 ? 'text-red-600' : ''}`}>
                    {fmtUsd(totalUnrealizedPnl, 2, true)}
                  </td>
                  <td className={`px-4 py-2.5 text-right tabular-nums text-xs ${totalUnrealizedPnl > 0 ? 'text-emerald-600' : totalUnrealizedPnl < 0 ? 'text-red-600' : ''}`}>
                    {totalCostBasis > 0 ? `${totalUnrealizedPnl >= 0 ? '+' : ''}${((totalUnrealizedPnl / totalCostBasis) * 100).toFixed(1)}%` : ''}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      ) : (
        <div className="text-center py-8">
          <Briefcase className="w-10 h-10 text-[hsl(var(--muted-foreground))] opacity-40 mx-auto" />
          <p className="mt-3 text-sm text-[hsl(var(--muted-foreground))]">No positions in IB account</p>
        </div>
      )}

      {orders.length > 0 && (
        <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))]">
            <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">Open Orders</h3>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[hsl(var(--secondary))]/50 text-[hsl(var(--muted-foreground))] text-xs">
                <th className="text-left px-4 py-2.5 font-medium">Symbol</th>
                <th className="text-left px-4 py-2.5 font-medium">Side</th>
                <th className="text-left px-4 py-2.5 font-medium">Type</th>
                <th className="text-right px-4 py-2.5 font-medium">Price</th>
                <th className="text-right px-4 py-2.5 font-medium">Qty</th>
                <th className="text-left px-4 py-2.5 font-medium">Status</th>
                <th className="text-left px-4 py-2.5 font-medium">Role</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[hsl(var(--border))]">
              {orders.map((order, i) => {
                const isChild = order.parentId && order.parentId !== 0;
                const isStop = order.orderType === 'STP';
                const isLimit = order.orderType === 'LMT';
                let role = 'Entry';
                if (isChild && isStop) role = 'Stop Loss';
                else if (isChild && isLimit) role = 'Take Profit';
                return (
                  <tr key={`${order.orderId}-${i}`} className={`hover:bg-[hsl(var(--secondary))]/50 ${isChild ? 'bg-slate-50/50' : ''}`}>
                    <td className={`px-4 py-2.5 ${isChild ? 'pl-8 text-[hsl(var(--muted-foreground))]' : 'font-bold'}`}>
                      {order.ticker}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold ${order.side === 'BUY' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                        {order.side}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-[hsl(var(--muted-foreground))]">{order.orderType}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {order.price ? `$${Number(order.price).toFixed(2)}` : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{order.quantity}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold ${
                        order.status === 'Filled' ? 'bg-emerald-100 text-emerald-700'
                          : order.status === 'Cancelled' ? 'bg-slate-100 text-slate-500'
                          : 'bg-blue-100 text-blue-700'
                      }`}>
                        {order.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-[hsl(var(--muted-foreground))]">
                      {isChild ? (
                        <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${isStop ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-600'}`}>
                          {role}
                        </span>
                      ) : role}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pendingSignals.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/40 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-amber-200/60 bg-amber-50">
            <h3 className="text-sm font-semibold text-amber-800">
              Queued Strategy Signals ({pendingSignals.length})
            </h3>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-amber-50/80 text-amber-700 text-xs">
                <th className="text-left px-4 py-2.5 font-medium">Symbol</th>
                <th className="text-left px-4 py-2.5 font-medium">Signal</th>
                <th className="text-left px-4 py-2.5 font-medium">Mode</th>
                <th className="text-right px-4 py-2.5 font-medium">Trigger</th>
                <th className="text-right px-4 py-2.5 font-medium">Applicable Date</th>
                <th className="text-left px-4 py-2.5 font-medium">Strategy</th>
                <th className="text-left px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-amber-200/60">
              {pendingSignals.map(signal => (
                <tr key={signal.id} className="hover:bg-amber-50/80">
                  <td className="px-4 py-2.5 font-bold">{signal.ticker}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold ${signal.signal === 'BUY' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                      {signal.signal}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-[hsl(var(--muted-foreground))]">
                    {signal.mode.replace('_', ' ')}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {signal.entry_price != null ? `$${signal.entry_price.toFixed(2)}` : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{signal.execute_on_date}</td>
                  <td className="px-4 py-2.5 text-xs">
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
                  <td className="px-4 py-2.5">
                    <StatusBadge status={signal.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {positions.length > 0 && positions.every(p => p.mktPrice === 0) && (
        <div className="flex items-start gap-2 rounded-lg bg-blue-50 border border-blue-200/70 px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-blue-800">Market data not available</p>
            <p className="text-xs text-blue-700 mt-0.5">
              IB paper accounts require a market data subscription for live prices.
              Cost basis and share counts are from your fills.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
