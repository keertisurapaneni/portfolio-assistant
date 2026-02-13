import { useState, useEffect, useCallback } from 'react';
import {
  Bot,
  Wifi,
  WifiOff,
  Play,
  Pause,
  RefreshCw,
  DollarSign,
  Target,
  Shield,
  Clock,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Settings,
  BarChart3,
  Activity,
  Zap,
  Briefcase,
  TrendingUp,
  TrendingDown,
} from 'lucide-react';
import { cn } from '../lib/utils';
import {
  type AutoTraderConfig,
  type AutoTradeEvent,
  getAutoTraderConfig,
  saveAutoTraderConfig,
  isIBConnected,
  onConnectionChange,
  onEventLogChange,
  getEventLog,
  startSessionPing,
  stopSessionPing,
  syncPositions,
  scheduleDayTradeAutoClose,
} from '../lib/autoTrader';
import { getAccounts, getPositions, getLiveOrders, type IBPosition, type IBLiveOrder } from '../lib/ibClient';
import {
  type PaperTrade,
  type TradePerformance,
  getActiveTrades,
  getAllTrades,
  getPerformance,
  recalculatePerformance,
} from '../lib/paperTradesApi';
import { Spinner } from './Spinner';
import { analyzeUnreviewedTrades, updatePerformancePatterns } from '../lib/aiFeedback';

// ── Main Component ──────────────────────────────────────

type Tab = 'portfolio' | 'positions' | 'history' | 'settings';

export function PaperTrading() {
  const [config, setConfig] = useState<AutoTraderConfig>(getAutoTraderConfig);
  const [connected, setConnected] = useState(isIBConnected());
  const [events, setEvents] = useState<AutoTradeEvent[]>(getEventLog());
  const [activeTrades, setActiveTrades] = useState<PaperTrade[]>([]);
  const [allTrades, setAllTrades] = useState<PaperTrade[]>([]);
  const [performance, setPerformance] = useState<TradePerformance | null>(null);
  const [ibPositions, setIbPositions] = useState<IBPosition[]>([]);
  const [ibOrders, setIbOrders] = useState<IBLiveOrder[]>([]);
  const [tab, setTab] = useState<Tab>('portfolio');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  // Load data from Supabase + IB
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [active, all, perf] = await Promise.all([
        getActiveTrades(),
        getAllTrades(50),
        getPerformance(),
      ]);
      setActiveTrades(active);
      setAllTrades(all);
      setPerformance(perf);
    } catch (err) {
      console.error('Failed to load paper trading data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load live IB positions & orders (separate from Supabase data)
  const loadIBData = useCallback(async () => {
    if (!connected) return;
    try {
      const [positions, orders] = await Promise.all([
        getPositions(config.accountId ?? ''),
        getLiveOrders(),
      ]);
      setIbPositions(positions);
      setIbOrders(orders);
    } catch (err) {
      console.error('Failed to load IB data:', err);
    }
  }, [connected, config.accountId]);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => { loadIBData(); }, [loadIBData]);

  // Auto-analyze unreviewed trades on page load
  useEffect(() => {
    analyzeUnreviewedTrades()
      .then(count => {
        if (count > 0) {
          console.log(`[PaperTrading] Analyzed ${count} new trades`);
          updatePerformancePatterns().catch(console.error);
          loadData(); // Refresh stats
        }
      })
      .catch(console.error);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to connection changes
  useEffect(() => {
    const unsub = onConnectionChange(setConnected);
    return unsub;
  }, []);

  // Subscribe to event log
  useEffect(() => {
    const unsub = onEventLogChange(setEvents);
    return unsub;
  }, []);

  // Always ping on page load so we show live connection status;
  // also schedule day-trade auto-close when enabled
  useEffect(() => {
    startSessionPing();
    if (config.enabled) {
      scheduleDayTradeAutoClose(config);
    }
    return () => stopSessionPing();
  }, [config.enabled]);

  // Toggle auto-trading
  const handleToggle = async () => {
    if (!config.enabled && !config.accountId) {
      // Try to discover account
      try {
        const accounts = await getAccounts();
        if (accounts.length > 0) {
          const updated = saveAutoTraderConfig({ accountId: accounts[0], enabled: true });
          setConfig(updated);
          return;
        }
      } catch {
        // Gateway not reachable
      }
    }

    const updated = saveAutoTraderConfig({ enabled: !config.enabled });
    setConfig(updated);
  };

  // Sync positions with IB
  const handleSync = async () => {
    setSyncing(true);
    try {
      if (config.accountId) {
        await syncPositions(config.accountId);
        await recalculatePerformance();
      }
      await Promise.all([loadData(), loadIBData()]);
    } catch (err) {
      console.error('Sync failed:', err);
    } finally {
      setSyncing(false);
    }
  };

  // Update config
  const updateConfig = (updates: Partial<AutoTraderConfig>) => {
    const updated = saveAutoTraderConfig(updates);
    setConfig(updated);
  };

  const completedTrades = allTrades.filter(t =>
    ['STOPPED', 'TARGET_HIT', 'CLOSED', 'CANCELLED', 'REJECTED'].includes(t.status)
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[hsl(var(--foreground))]">Paper Trading</h1>
            <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">
              Auto-execute scanner signals on IB paper account
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* Sync button */}
            <button
              onClick={handleSync}
              disabled={syncing || !connected}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-all',
                'hover:bg-[hsl(var(--secondary))]',
                syncing && 'opacity-50 cursor-not-allowed'
              )}
            >
              <RefreshCw className={cn('w-3.5 h-3.5', syncing && 'animate-spin')} />
              Sync
            </button>

            {/* Auto-trade toggle */}
            <button
              onClick={handleToggle}
              className={cn(
                'flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all',
                config.enabled
                  ? 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-md shadow-emerald-500/25'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              )}
            >
              {config.enabled ? (
                <>
                  <Pause className="w-4 h-4" />
                  Disable Auto-Trading
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  Enable Auto-Trading
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Status Banner */}
      <div className={cn(
        'flex items-center gap-3 px-4 py-3 rounded-xl border',
        connected
          ? 'bg-emerald-50 border-emerald-200'
          : 'bg-red-50 border-red-200'
      )}>
        {connected ? (
          <Wifi className="w-5 h-5 text-emerald-600 flex-shrink-0" />
        ) : (
          <WifiOff className="w-5 h-5 text-red-600 flex-shrink-0" />
        )}
        <div className="flex-1">
          <p className={cn('text-sm font-medium', connected ? 'text-emerald-800' : 'text-red-800')}>
            {connected ? 'IB Gateway Connected' : 'IB Gateway Disconnected'}
          </p>
          <p className={cn('text-xs', connected ? 'text-emerald-600' : 'text-red-600')}>
            {connected
              ? `Account: ${config.accountId ?? 'detecting...'}`
              : 'Start auto-trader service (./auto-trader/start.sh)'}
          </p>
        </div>
        {config.enabled && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-700">
            <Bot className="w-3.5 h-3.5" />
            <span className="text-xs font-semibold">AUTO</span>
          </div>
        )}
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={<BarChart3 className="w-4 h-4" />}
          label="Total Trades"
          value={String(performance?.total_trades ?? 0)}
          color="blue"
        />
        <StatCard
          icon={<Target className="w-4 h-4" />}
          label="Win Rate"
          value={`${(performance?.win_rate ?? 0).toFixed(1)}%`}
          color={(performance?.win_rate ?? 0) >= 50 ? 'green' : 'red'}
        />
        <StatCard
          icon={<DollarSign className="w-4 h-4" />}
          label="Total P&L"
          value={`$${(performance?.total_pnl ?? 0).toFixed(2)}`}
          color={(performance?.total_pnl ?? 0) >= 0 ? 'green' : 'red'}
        />
        <StatCard
          icon={<Activity className="w-4 h-4" />}
          label="Active"
          value={String(activeTrades.length)}
          color="amber"
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-white/60 p-1 rounded-xl border border-[hsl(var(--border))]">
        {[
          { id: 'portfolio' as Tab, label: 'IB Portfolio', icon: Briefcase, count: ibPositions.length },
          { id: 'positions' as Tab, label: 'Auto-Trades', icon: Zap, count: activeTrades.length },
          { id: 'history' as Tab, label: 'Trade History', icon: Clock, count: completedTrades.length },
          { id: 'settings' as Tab, label: 'Settings', icon: Settings },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all',
              tab === t.id
                ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md'
                : 'text-slate-500 hover:text-slate-700 hover:bg-white/80'
            )}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
            {t.count !== undefined && t.count > 0 && (
              <span className={cn(
                'ml-0.5 px-1.5 py-0.5 text-xs rounded-full font-semibold',
                tab === t.id ? 'bg-white/25' : 'bg-slate-100'
              )}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner size="lg" />
        </div>
      ) : (
        <>
          {tab === 'portfolio' && (
            <PortfolioTab
              positions={ibPositions}
              orders={ibOrders}
              connected={connected}
              onRefresh={loadIBData}
            />
          )}
          {tab === 'positions' && (
            <PositionsTab trades={activeTrades} />
          )}
          {tab === 'history' && (
            <HistoryTab trades={completedTrades} />
          )}
          {tab === 'settings' && (
            <SettingsTab config={config} onUpdate={updateConfig} />
          )}
        </>
      )}

      {/* Event Log */}
      {events.length > 0 && (
        <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))]">
            <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">Activity Log</h3>
          </div>
          <div className="max-h-48 overflow-y-auto divide-y divide-[hsl(var(--border))]">
            {events.slice(0, 20).map((event, i) => (
              <div key={i} className="flex items-start gap-2 px-4 py-2 text-xs">
                {event.type === 'success' && <CheckCircle className="w-3.5 h-3.5 text-emerald-500 mt-0.5 flex-shrink-0" />}
                {event.type === 'error' && <XCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0" />}
                {event.type === 'warning' && <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" />}
                {event.type === 'info' && <Activity className="w-3.5 h-3.5 text-blue-500 mt-0.5 flex-shrink-0" />}
                <div className="flex-1 min-w-0">
                  <span className="font-bold text-[hsl(var(--foreground))]">{event.ticker}</span>
                  <span className="text-[hsl(var(--muted-foreground))] ml-1.5">{event.message}</span>
                </div>
                <span className="text-[hsl(var(--muted-foreground))] flex-shrink-0 tabular-nums">
                  {new Date(event.timestamp).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Stat Card ────────────────────────────────────────────

function StatCard({ icon, label, value, color }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: 'blue' | 'green' | 'red' | 'amber';
}) {
  const colors = {
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
  };

  return (
    <div className={cn('rounded-xl border p-4', colors[color])}>
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <span className="text-xs font-medium opacity-75">{label}</span>
      </div>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}

// ── Portfolio Tab (Live IB Data) ─────────────────────────

function PortfolioTab({ positions, orders, connected, onRefresh }: {
  positions: IBPosition[];
  orders: IBLiveOrder[];
  connected: boolean;
  onRefresh: () => void;
}) {
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
  const parentOrders = orders.filter(o => !o.parentId || o.parentId === 0);

  return (
    <div className="space-y-4">
      {/* Portfolio Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl border bg-indigo-50 border-indigo-200 text-indigo-700 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Briefcase className="w-4 h-4" />
            <span className="text-xs font-medium opacity-75">Holdings</span>
          </div>
          <p className="text-2xl font-bold">{positions.length}</p>
        </div>
        <div className="rounded-xl border bg-blue-50 border-blue-200 text-blue-700 p-4">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="w-4 h-4" />
            <span className="text-xs font-medium opacity-75">Cost Basis</span>
          </div>
          <p className="text-2xl font-bold">${totalCostBasis.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        </div>
        <div className={cn(
          'rounded-xl border p-4',
          totalMktValue > 0 ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-slate-50 border-slate-200 text-slate-600'
        )}>
          <div className="flex items-center gap-2 mb-2">
            <BarChart3 className="w-4 h-4" />
            <span className="text-xs font-medium opacity-75">Market Value</span>
          </div>
          <p className="text-2xl font-bold">
            {totalMktValue > 0 ? `$${totalMktValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
          </p>
        </div>
        <div className="rounded-xl border bg-amber-50 border-amber-200 text-amber-700 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="w-4 h-4" />
            <span className="text-xs font-medium opacity-75">Open Orders</span>
          </div>
          <p className="text-2xl font-bold">{parentOrders.length}</p>
        </div>
      </div>

      {/* Positions Table */}
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
                <th className="text-left px-4 py-2.5 font-medium">Symbol</th>
                <th className="text-right px-4 py-2.5 font-medium">Shares</th>
                <th className="text-right px-4 py-2.5 font-medium">Avg Cost</th>
                <th className="text-right px-4 py-2.5 font-medium">Cost Basis</th>
                <th className="text-right px-4 py-2.5 font-medium">Mkt Price</th>
                <th className="text-right px-4 py-2.5 font-medium">Mkt Value</th>
                <th className="text-right px-4 py-2.5 font-medium">Unrealized P&L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[hsl(var(--border))]">
              {positions
                .sort((a, b) => Math.abs(b.position * b.avgCost) - Math.abs(a.position * a.avgCost))
                .map((pos, i) => {
                  const costBasis = Math.abs(pos.position) * pos.avgCost;
                  const pnl = pos.unrealizedPnl;
                  const hasMktData = pos.mktPrice > 0;
                  return (
                    <tr key={`${pos.conid}-${i}`} className="hover:bg-[hsl(var(--secondary))]/50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-bold">{pos.contractDesc}</span>
                          <span className={cn(
                            'inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold',
                            pos.position > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                          )}>
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
                      <td className={cn(
                        'px-4 py-3 text-right tabular-nums font-semibold',
                        pnl > 0 ? 'text-emerald-600' : pnl < 0 ? 'text-red-600' : ''
                      )}>
                        {hasMktData ? (
                          <span className="flex items-center justify-end gap-1">
                            {pnl > 0 ? <TrendingUp className="w-3 h-3" /> : pnl < 0 ? <TrendingDown className="w-3 h-3" /> : null}
                            {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                          </span>
                        ) : <span className="text-[hsl(var(--muted-foreground))] opacity-50">—</span>}
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
                  <td className={cn(
                    'px-4 py-2.5 text-right tabular-nums',
                    totalUnrealizedPnl > 0 ? 'text-emerald-600' : totalUnrealizedPnl < 0 ? 'text-red-600' : ''
                  )}>
                    {totalUnrealizedPnl >= 0 ? '+' : ''}${totalUnrealizedPnl.toFixed(2)}
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

      {/* Open Orders */}
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
                  <tr key={`${order.orderId}-${i}`} className={cn('hover:bg-[hsl(var(--secondary))]/50', isChild && 'bg-slate-50/50')}>
                    <td className={cn('px-4 py-2.5', isChild ? 'pl-8 text-[hsl(var(--muted-foreground))]' : 'font-bold')}>
                      {order.ticker}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={cn(
                        'inline-flex px-2 py-0.5 rounded text-[10px] font-bold',
                        order.side === 'BUY' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                      )}>
                        {order.side}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-[hsl(var(--muted-foreground))]">{order.orderType}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {order.price ? `$${Number(order.price).toFixed(2)}` : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{order.quantity}</td>
                    <td className="px-4 py-2.5">
                      <span className={cn(
                        'inline-flex px-2 py-0.5 rounded text-[10px] font-bold',
                        order.status === 'Filled' ? 'bg-emerald-100 text-emerald-700'
                          : order.status === 'Cancelled' ? 'bg-slate-100 text-slate-500'
                          : 'bg-blue-100 text-blue-700'
                      )}>
                        {order.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-[hsl(var(--muted-foreground))]">
                      {isChild ? (
                        <span className={cn(
                          'inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium',
                          isStop ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-600'
                        )}>
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

      {/* Note about market data */}
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

// ── Positions Tab ────────────────────────────────────────

function PositionsTab({ trades }: { trades: PaperTrade[] }) {
  if (trades.length === 0) {
    return (
      <div className="text-center py-12">
        <Shield className="w-10 h-10 text-[hsl(var(--muted-foreground))] opacity-40 mx-auto" />
        <p className="mt-3 text-sm text-[hsl(var(--muted-foreground))]">No active positions</p>
        <p className="text-xs text-[hsl(var(--muted-foreground))] opacity-70 mt-1">
          Enable auto-trading to start executing scanner signals
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))] text-xs">
            <th className="text-left px-4 py-2.5 font-medium">Ticker</th>
            <th className="text-left px-4 py-2.5 font-medium">Signal</th>
            <th className="text-right px-4 py-2.5 font-medium">Entry</th>
            <th className="text-right px-4 py-2.5 font-medium">Stop</th>
            <th className="text-right px-4 py-2.5 font-medium">Target</th>
            <th className="text-right px-4 py-2.5 font-medium">Qty</th>
            <th className="text-left px-4 py-2.5 font-medium">Status</th>
            <th className="text-left px-4 py-2.5 font-medium">Mode</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[hsl(var(--border))]">
          {trades.map(trade => (
            <tr key={trade.id} className="hover:bg-[hsl(var(--secondary))]/50">
              <td className="px-4 py-3 font-bold">{trade.ticker}</td>
              <td className="px-4 py-3">
                <span className={cn(
                  'inline-flex px-2 py-0.5 rounded text-[10px] font-bold',
                  trade.signal === 'BUY' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                )}>
                  {trade.signal}
                </span>
              </td>
              <td className="px-4 py-3 text-right tabular-nums">${trade.entry_price?.toFixed(2)}</td>
              <td className="px-4 py-3 text-right tabular-nums text-red-600">${trade.stop_loss?.toFixed(2)}</td>
              <td className="px-4 py-3 text-right tabular-nums text-emerald-600">${trade.target_price?.toFixed(2)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{trade.quantity}</td>
              <td className="px-4 py-3">
                <StatusBadge status={trade.status} />
              </td>
              <td className="px-4 py-3 text-xs text-[hsl(var(--muted-foreground))]">
                {trade.mode === 'DAY_TRADE' ? 'Day' : 'Swing'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── History Tab ──────────────────────────────────────────

function HistoryTab({ trades }: { trades: PaperTrade[] }) {
  if (trades.length === 0) {
    return (
      <div className="text-center py-12">
        <Clock className="w-10 h-10 text-[hsl(var(--muted-foreground))] opacity-40 mx-auto" />
        <p className="mt-3 text-sm text-[hsl(var(--muted-foreground))]">No completed trades yet</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))] text-xs">
            <th className="text-left px-4 py-2.5 font-medium">Ticker</th>
            <th className="text-left px-4 py-2.5 font-medium">Signal</th>
            <th className="text-right px-4 py-2.5 font-medium">Entry</th>
            <th className="text-right px-4 py-2.5 font-medium">Close</th>
            <th className="text-right px-4 py-2.5 font-medium">P&L</th>
            <th className="text-left px-4 py-2.5 font-medium">Result</th>
            <th className="text-left px-4 py-2.5 font-medium">Reason</th>
            <th className="text-left px-4 py-2.5 font-medium">Date</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[hsl(var(--border))]">
          {trades.map(trade => (
            <tr key={trade.id} className="hover:bg-[hsl(var(--secondary))]/50">
              <td className="px-4 py-3 font-bold">{trade.ticker}</td>
              <td className="px-4 py-3">
                <span className={cn(
                  'inline-flex px-2 py-0.5 rounded text-[10px] font-bold',
                  trade.signal === 'BUY' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                )}>
                  {trade.signal}
                </span>
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                ${trade.fill_price?.toFixed(2) ?? trade.entry_price?.toFixed(2)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {trade.close_price ? `$${trade.close_price.toFixed(2)}` : '—'}
              </td>
              <td className={cn(
                'px-4 py-3 text-right tabular-nums font-semibold',
                (trade.pnl ?? 0) > 0 ? 'text-emerald-600' : (trade.pnl ?? 0) < 0 ? 'text-red-600' : ''
              )}>
                {trade.pnl != null ? `${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}` : '—'}
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={trade.status} />
              </td>
              <td className="px-4 py-3 text-xs text-[hsl(var(--muted-foreground))]">
                {trade.close_reason ?? '—'}
              </td>
              <td className="px-4 py-3 text-xs text-[hsl(var(--muted-foreground))] tabular-nums">
                {new Date(trade.opened_at).toLocaleDateString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Settings Tab ─────────────────────────────────────────

function SettingsTab({ config, onUpdate }: {
  config: AutoTraderConfig;
  onUpdate: (updates: Partial<AutoTraderConfig>) => void;
}) {
  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-6 space-y-6">
      <h3 className="text-lg font-semibold text-[hsl(var(--foreground))]">Auto-Trading Settings</h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Position Size */}
        <div>
          <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
            Position Size (per trade)
          </label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-[hsl(var(--muted-foreground))]">$</span>
            <input
              type="number"
              value={config.positionSize}
              onChange={e => onUpdate({ positionSize: Number(e.target.value) })}
              className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm"
              min={100}
              step={100}
            />
          </div>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Paper money allocated per trade</p>
        </div>

        {/* Max Positions */}
        <div>
          <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
            Max Concurrent Positions
          </label>
          <input
            type="number"
            value={config.maxPositions}
            onChange={e => onUpdate({ maxPositions: Number(e.target.value) })}
            className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm"
            min={1}
            max={10}
          />
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Max open positions at once</p>
        </div>

        {/* Min Scanner Confidence */}
        <div>
          <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
            Min Scanner Confidence
          </label>
          <input
            type="number"
            value={config.minScannerConfidence}
            onChange={e => onUpdate({ minScannerConfidence: Number(e.target.value) })}
            className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm"
            min={1}
            max={10}
          />
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Scanner confidence threshold (1-10)</p>
        </div>

        {/* Min FA Confidence */}
        <div>
          <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
            Min Full Analysis Confidence
          </label>
          <input
            type="number"
            value={config.minFAConfidence}
            onChange={e => onUpdate({ minFAConfidence: Number(e.target.value) })}
            className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm"
            min={1}
            max={10}
          />
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Both scanner AND FA must meet threshold</p>
        </div>

        {/* IB Account */}
        <div>
          <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
            IB Account ID
          </label>
          <input
            type="text"
            value={config.accountId ?? ''}
            onChange={e => onUpdate({ accountId: e.target.value || null })}
            className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm font-mono"
            placeholder="Auto-detected from gateway"
          />
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Paper account ID (auto-detected on connect)</p>
        </div>

        {/* Day Trade Auto-Close */}
        <div className="flex items-center gap-3 pt-6">
          <button
            onClick={() => onUpdate({ dayTradeAutoClose: !config.dayTradeAutoClose })}
            className={cn(
              'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
              config.dayTradeAutoClose ? 'bg-emerald-600' : 'bg-slate-300'
            )}
          >
            <span className={cn(
              'inline-block h-4 w-4 rounded-full bg-white transition-transform',
              config.dayTradeAutoClose ? 'translate-x-6' : 'translate-x-1'
            )} />
          </button>
          <div>
            <p className="text-sm font-medium text-[hsl(var(--foreground))]">Day Trade Auto-Close</p>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">Close all day trades at 3:55 PM ET</p>
          </div>
        </div>
      </div>

      {/* Risk Warning */}
      <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200/70 px-4 py-3 mt-4">
        <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-sm font-medium text-amber-800">Paper Trading Only</p>
          <p className="text-xs text-amber-700 mt-0.5">
            Orders are placed on your IB paper account with simulated money.
            No real funds are at risk. This is for testing AI signal quality only.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Status Badge ─────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    PENDING: 'bg-slate-100 text-slate-600',
    SUBMITTED: 'bg-blue-100 text-blue-700',
    FILLED: 'bg-emerald-100 text-emerald-700',
    PARTIAL: 'bg-amber-100 text-amber-700',
    STOPPED: 'bg-red-100 text-red-700',
    TARGET_HIT: 'bg-emerald-100 text-emerald-700',
    CLOSED: 'bg-slate-100 text-slate-600',
    CANCELLED: 'bg-slate-100 text-slate-500',
    REJECTED: 'bg-red-100 text-red-700',
  };

  return (
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold',
      styles[status] ?? 'bg-slate-100 text-slate-600'
    )}>
      {status.replace('_', ' ')}
    </span>
  );
}
