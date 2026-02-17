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
  Brain,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Gauge,
} from 'lucide-react';
import { cn } from '../lib/utils';
import {
  type AutoTraderConfig,
  type AutoTradeEvent,
  getAutoTraderConfig,
  loadAutoTraderConfig,
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
  type AutoTradeEventRecord,
  type CategoryPerformance,
  getAllTrades,
  getPerformance,
  recalculatePerformance,
  recalculatePerformanceByCategory,
  getAutoTradeEvents,
} from '../lib/paperTradesApi';
import { getTotalDeployed, getMarketRegime, calculateKellyMultiplier, type MarketRegime } from '../lib/autoTrader';
import { Spinner } from './Spinner';
import { analyzeUnreviewedTrades, updatePerformancePatterns } from '../lib/aiFeedback';

/** Format a dollar amount with sign before $: +$500, -$718, $0 */
function fmtUsd(value: number, decimals = 2, showPlus = false): string {
  const sign = value > 0 && showPlus ? '+' : value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(decimals)}`;
}

// ── Main Component ──────────────────────────────────────

type Tab = 'portfolio' | 'today' | 'smart' | 'signals' | 'history' | 'settings';

export function PaperTrading() {
  const [config, setConfig] = useState<AutoTraderConfig>(getAutoTraderConfig);
  const [connected, setConnected] = useState(isIBConnected());
  const [events, setEvents] = useState<AutoTradeEvent[]>(getEventLog());
  const [allTrades, setAllTrades] = useState<PaperTrade[]>([]);
  const [performance, setPerformance] = useState<TradePerformance | null>(null);
  const [ibPositions, setIbPositions] = useState<IBPosition[]>([]);
  const [ibOrders, setIbOrders] = useState<IBLiveOrder[]>([]);
  const [persistedEvents, setPersistedEvents] = useState<AutoTradeEventRecord[]>([]);
  const [categoryPerf, setCategoryPerf] = useState<CategoryPerformance[]>([]);
  const [totalDeployed, setTotalDeployed] = useState(0);
  const [marketRegime, setMarketRegime] = useState<MarketRegime | null>(null);
  const [kellyMultiplier, setKellyMultiplier] = useState<number>(1.0);
  const [tab, setTab] = useState<Tab>('portfolio');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  // Load data from Supabase + IB
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [all, perf, savedEvents, catPerf, deployed, regime, kelly] = await Promise.all([
        getAllTrades(50),
        getPerformance(),
        getAutoTradeEvents(100),
        recalculatePerformanceByCategory(),
        getTotalDeployed(),
        getMarketRegime(config),
        calculateKellyMultiplier(config),
      ]);
      setAllTrades(all);
      setPerformance(perf);
      setPersistedEvents(savedEvents);
      setCategoryPerf(catPerf);
      setTotalDeployed(deployed);
      setMarketRegime(regime);
      setKellyMultiplier(kelly);
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

  // Load config from Supabase on mount (overrides stale localStorage)
  useEffect(() => {
    loadAutoTraderConfig().then(setConfig);
  }, []);

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
          const updated = await saveAutoTraderConfig({ accountId: accounts[0], enabled: true });
          setConfig(updated);
          return;
        }
      } catch {
        // Gateway not reachable
      }
    }

    const updated = await saveAutoTraderConfig({ enabled: !config.enabled });
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
  const updateConfig = async (updates: Partial<AutoTraderConfig>) => {
    const updated = await saveAutoTraderConfig(updates);
    setConfig(updated);
  };

  // Today's executed trades from activity log
  const todayStr = new Date().toDateString();
  const todaysExecuted = persistedEvents.filter(e =>
    e.action === 'executed' && new Date(e.created_at).toDateString() === todayStr
  );

  // Portfolio totals (for consolidated stats row)
  const totalCostBasis = ibPositions.reduce((sum, p) => sum + Math.abs(p.position) * p.avgCost, 0);
  const totalMktValue = ibPositions.reduce((sum, p) => sum + p.mktValue, 0);
  const totalUnrealizedPnl = ibPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const uniqueOrderTickers = new Set(ibOrders.map(o => o.ticker)).size;

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

      {/* Consolidated Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard
          icon={<Briefcase className="w-4 h-4" />}
          label="Holdings"
          value={String(ibPositions.length)}
          subtitle={uniqueOrderTickers > 0 ? `${uniqueOrderTickers} open order${uniqueOrderTickers > 1 ? 's' : ''}` : undefined}
          color="blue"
        />
        <StatCard
          icon={<DollarSign className="w-4 h-4" />}
          label="Cost Basis"
          value={connected && totalCostBasis > 0 ? `$${totalCostBasis.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'}
          color="blue"
        />
        <StatCard
          icon={<BarChart3 className="w-4 h-4" />}
          label="Market Value"
          value={connected && totalMktValue > 0 ? `$${totalMktValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'}
          color={totalMktValue >= totalCostBasis ? 'green' : 'red'}
        />
        <StatCard
          icon={<TrendingUp className="w-4 h-4" />}
          label="Unrealized P&L"
          value={connected && totalMktValue > 0 ? fmtUsd(totalUnrealizedPnl, 0, true) : '—'}
          subtitle={`Realized: ${fmtUsd(performance?.total_pnl ?? 0, 0, true)}`}
          color={totalUnrealizedPnl >= 0 ? 'green' : 'red'}
        />
        <StatCard
          icon={<Target className="w-4 h-4" />}
          label="Win Rate"
          value={`${(performance?.win_rate ?? 0).toFixed(0)}%`}
          subtitle={`${performance?.total_trades ?? 0} closed trade${(performance?.total_trades ?? 0) !== 1 ? 's' : ''}`}
          color={(performance?.win_rate ?? 0) >= 50 ? 'green' : 'red'}
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-white/60 p-1 rounded-xl border border-[hsl(var(--border))]">
        {[
          { id: 'portfolio' as Tab, label: 'IB Portfolio', icon: Briefcase, count: ibPositions.length },
          { id: 'today' as Tab, label: "Today's Activity", icon: Zap, count: todaysExecuted.length },
          { id: 'history' as Tab, label: 'Trade History', icon: Clock, count: allTrades.length },
          { id: 'signals' as Tab, label: 'Signal Quality', icon: Target },
          { id: 'smart' as Tab, label: 'Smart Trading', icon: Brain },
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
          {tab === 'today' && (
            <TodaysActivityTab events={todaysExecuted} trades={allTrades} />
          )}
          {tab === 'smart' && (
            <SmartTradingTab
              config={config}
              regime={marketRegime}
              kellyMultiplier={kellyMultiplier}
              totalDeployed={totalDeployed}
              events={persistedEvents}
              positions={ibPositions}
            />
          )}
          {tab === 'signals' && (
            <PerformanceBreakdown
              categories={categoryPerf}
              totalDeployed={totalDeployed}
              maxAllocation={config.maxTotalAllocation}
            />
          )}
          {tab === 'history' && (
            <HistoryTab trades={allTrades} />
          )}
          {tab === 'settings' && (
            <SettingsTab config={config} onUpdate={updateConfig} />
          )}
        </>
      )}

      {/* Activity Log — shows session events + persisted history */}
      {(events.length > 0 || persistedEvents.length > 0) && (
        <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))] flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">Activity Log</h3>
            {persistedEvents.length > 0 && (
              <span className="text-xs text-[hsl(var(--muted-foreground))]">{persistedEvents.length} saved events</span>
            )}
          </div>
          <div className="max-h-64 overflow-y-auto divide-y divide-[hsl(var(--border))]">
            {/* Current session events first */}
            {events.slice(0, 20).map((event, i) => (
              <div key={`live-${i}`} className="flex items-start gap-2 px-4 py-2 text-xs">
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
            {/* Persisted events (from Supabase) with date */}
            {persistedEvents
              .filter(e => e.action) // only show decision events (not info-only)
              .slice(0, 50)
              .map((event) => (
              <div key={event.id} className="flex items-start gap-2 px-4 py-2 text-xs bg-[hsl(var(--secondary))]/30">
                {event.event_type === 'success' && <CheckCircle className="w-3.5 h-3.5 text-emerald-500 mt-0.5 flex-shrink-0" />}
                {event.event_type === 'error' && <XCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0" />}
                {event.event_type === 'warning' && <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" />}
                {event.event_type === 'info' && <Activity className="w-3.5 h-3.5 text-blue-500 mt-0.5 flex-shrink-0" />}
                <div className="flex-1 min-w-0">
                  <span className="font-bold text-[hsl(var(--foreground))]">{event.ticker}</span>
                  {event.action && (
                    <span className={cn('ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium', {
                      'bg-emerald-100 text-emerald-700': event.action === 'executed',
                      'bg-amber-100 text-amber-700': event.action === 'skipped',
                      'bg-red-100 text-red-700': event.action === 'failed',
                    })}>{event.action}</span>
                  )}
                  <span className="text-[hsl(var(--muted-foreground))] ml-1.5">{event.message}</span>
                  {event.scanner_confidence != null && event.fa_confidence != null && (
                    <span className="text-[hsl(var(--muted-foreground))] ml-1.5 opacity-60">
                      {event.source === 'suggested_finds'
                        ? `(Conviction: ${event.scanner_confidence})`
                        : `(Scanner: ${event.scanner_confidence}, FA: ${event.fa_confidence})`}
                    </span>
                  )}
                </div>
                <span className="text-[hsl(var(--muted-foreground))] flex-shrink-0 tabular-nums whitespace-nowrap">
                  {new Date(event.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{' '}
                  {new Date(event.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
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

function StatCard({ icon, label, value, subtitle, color }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  subtitle?: string;
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
      {subtitle && <p className="text-[10px] mt-0.5 opacity-60">{subtitle}</p>}
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

  return (
    <div className="space-y-4">
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
                            {fmtUsd(pnl, 2, true)}
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
                    {fmtUsd(totalUnrealizedPnl, 2, true)}
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

// ── History Tab ──────────────────────────────────────────

function TodaysActivityTab({ events, trades }: { events: AutoTradeEventRecord[]; trades: PaperTrade[] }) {
  // Match events with paper_trades to show P&L for closed trades
  const tradesByTicker = new Map<string, PaperTrade[]>();
  for (const t of trades) {
    const arr = tradesByTicker.get(t.ticker) || [];
    arr.push(t);
    tradesByTicker.set(t.ticker, arr);
  }

  if (events.length === 0) {
    return (
      <div className="text-center py-12">
        <Zap className="w-10 h-10 text-[hsl(var(--muted-foreground))] opacity-40 mx-auto" />
        <p className="mt-3 text-sm text-[hsl(var(--muted-foreground))]">No trades executed today</p>
        <p className="text-xs text-[hsl(var(--muted-foreground))] opacity-70 mt-1">
          Scanner runs at 10 AM and 3:30 PM ET
        </p>
      </div>
    );
  }

  // Calculate today's total P&L (realized from closed + unrealized from active)
  const todayPnl = events.reduce((sum, ev) => {
    const matched = tradesByTicker.get(ev.ticker)?.find(t =>
      t.pnl != null || t.status === 'FILLED' || t.status === 'TARGET_HIT' || t.status === 'STOPPED' || t.status === 'CLOSED'
    );
    return sum + (matched?.pnl ?? 0);
  }, 0);

  return (
    <div className="space-y-3">
      {/* Today's summary */}
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
              const isClosed = isSystemClose || (matched?.close_price != null);
              const isActive = !isSystemClose && matched && !matched.close_price && ['FILLED', 'PARTIAL'].includes(matched.status);
              const msg = event.message;
              const qtyMatch = msg.match(/(\d+)\s+shares.*?@\s*~?\$?([\d.]+)/i);

              // Determine display mode: system events (target_hit, eod_close) don't have a mode
              const modeLabel = event.mode === 'DAY_TRADE' ? 'Day'
                : event.mode === 'SWING_TRADE' ? 'Swing'
                : event.mode === 'LONG_TERM' ? 'Long Term'
                : isSystemClose ? 'Close' : '—';

              // Signal: system close events don't have a scanner_signal
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
    </div>
  );
}

// ── History Tab ──────────────────────────────────────────

type HistorySortKey = 'date' | 'ticker' | 'pnl' | 'signal' | 'status';

function HistoryTab({ trades }: { trades: PaperTrade[] }) {
  const [sortKey, setSortKey] = useState<HistorySortKey>('date');
  const [sortAsc, setSortAsc] = useState(false);

  if (trades.length === 0) {
    return (
      <div className="text-center py-12">
        <Clock className="w-10 h-10 text-[hsl(var(--muted-foreground))] opacity-40 mx-auto" />
        <p className="mt-3 text-sm text-[hsl(var(--muted-foreground))]">No trades yet</p>
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
      className={cn('px-4 py-2.5 font-medium cursor-pointer select-none hover:text-[hsl(var(--foreground))] transition-colors', align === 'right' ? 'text-right' : 'text-left')}
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

  // Summary stats
  const activeTrades = trades.filter(t => ['SUBMITTED', 'FILLED', 'PARTIAL', 'PENDING'].includes(t.status));
  const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const wins = trades.filter(t => (t.pnl ?? 0) > 0).length;
  const losses = trades.filter(t => (t.pnl ?? 0) < 0).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-lg bg-[hsl(var(--secondary))] px-4 py-2.5">
        <div className="flex items-center gap-4 text-xs text-[hsl(var(--muted-foreground))]">
          <span>{trades.length} trades</span>
          {activeTrades.length > 0 && (
            <span className="text-blue-600">{activeTrades.length} active</span>
          )}
          <span className="text-emerald-600">{wins}W</span>
          <span className="text-red-500">{losses}L</span>
        </div>
        <span className={cn('text-sm font-bold tabular-nums', totalPnl > 0 ? 'text-emerald-600' : totalPnl < 0 ? 'text-red-600' : '')}>
          Total: {fmtUsd(totalPnl, 2, true)}
        </span>
      </div>

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
                <tr key={trade.id} className={cn('hover:bg-[hsl(var(--secondary))]/50', isActive && 'bg-blue-50/30')}>
                  <td className="px-4 py-3 font-bold">{trade.ticker}</td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      'inline-flex px-2 py-0.5 rounded text-[10px] font-bold',
                      trade.signal === 'BUY' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                    )}>
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
                  <td className={cn(
                    'px-4 py-3 text-right tabular-nums font-semibold',
                    (trade.pnl ?? 0) > 0 ? 'text-emerald-600' : (trade.pnl ?? 0) < 0 ? 'text-red-600' : ''
                  )}>
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

        {/* Min Suggested Finds Conviction */}
        <div>
          <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
            Suggested Finds Min Conviction
          </label>
          <input
            type="number"
            value={config.minSuggestedFindsConviction}
            onChange={e => onUpdate({ minSuggestedFindsConviction: Number(e.target.value) })}
            className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm"
            min={1}
            max={10}
          />
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Only Undervalued/Deep Value stocks at this conviction or higher</p>
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

      {/* Allocation Cap */}
      <div className="border-t border-[hsl(var(--border))] pt-6 mt-2">
        <h4 className="text-sm font-semibold text-[hsl(var(--foreground))] mb-4">Testing Budget</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1.5">
              Max Total Allocation
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-[hsl(var(--muted-foreground))]">$</span>
              <input
                type="number"
                value={config.maxTotalAllocation}
                onChange={e => onUpdate({ maxTotalAllocation: Number(e.target.value) })}
                className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-lg text-sm"
                min={10000}
                step={10000}
              />
            </div>
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Hard cap on total deployed capital</p>
          </div>
        </div>
      </div>

      {/* Dynamic Position Sizing */}
      <div className="border-t border-[hsl(var(--border))] pt-6 mt-2">
        <div className="flex items-center gap-3 mb-4">
          <SettingsToggle
            enabled={config.useDynamicSizing}
            onToggle={() => onUpdate({ useDynamicSizing: !config.useDynamicSizing })}
          />
          <div>
            <p className="text-sm font-semibold text-[hsl(var(--foreground))]">Dynamic Position Sizing</p>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">Conviction-weighted + risk-based sizing (replaces flat $ per trade)</p>
          </div>
        </div>
        {config.useDynamicSizing && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pl-14">
            <SettingsInput label="Base Allocation %" value={config.baseAllocationPct}
              onChange={v => onUpdate({ baseAllocationPct: v })} min={0.5} max={10} step={0.5}
              help="% of portfolio per long-term position" />
            <SettingsInput label="Max Position %" value={config.maxPositionPct}
              onChange={v => onUpdate({ maxPositionPct: v })} min={1} max={20} step={1}
              help="Max single-position % of portfolio" />
            <SettingsInput label="Risk Per Trade %" value={config.riskPerTradePct}
              onChange={v => onUpdate({ riskPerTradePct: v })} min={0.25} max={5} step={0.25}
              help="Max risk % per scanner trade" />
          </div>
        )}
      </div>

      {/* Dip Buying */}
      <div className="border-t border-[hsl(var(--border))] pt-6 mt-2">
        <div className="flex items-center gap-3 mb-4">
          <SettingsToggle
            enabled={config.dipBuyEnabled}
            onToggle={() => onUpdate({ dipBuyEnabled: !config.dipBuyEnabled })}
          />
          <div>
            <p className="text-sm font-semibold text-[hsl(var(--foreground))]">Dip Buying</p>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">Auto average-down when long-term positions drop</p>
          </div>
        </div>
        {config.dipBuyEnabled && (
          <div className="space-y-3 pl-14">
            <div className="grid grid-cols-3 gap-3">
              <div className="text-xs text-[hsl(var(--muted-foreground))] font-medium">Tier</div>
              <div className="text-xs text-[hsl(var(--muted-foreground))] font-medium">Dip %</div>
              <div className="text-xs text-[hsl(var(--muted-foreground))] font-medium">Add-on Size %</div>
            </div>
            {[
              { label: 'Tier 1', dipKey: 'dipBuyTier1Pct' as const, sizeKey: 'dipBuyTier1SizePct' as const },
              { label: 'Tier 2', dipKey: 'dipBuyTier2Pct' as const, sizeKey: 'dipBuyTier2SizePct' as const },
              { label: 'Tier 3', dipKey: 'dipBuyTier3Pct' as const, sizeKey: 'dipBuyTier3SizePct' as const },
            ].map(tier => (
              <div key={tier.label} className="grid grid-cols-3 gap-3 items-center">
                <span className="text-xs font-medium">{tier.label}</span>
                <input type="number" value={config[tier.dipKey]}
                  onChange={e => onUpdate({ [tier.dipKey]: Number(e.target.value) })}
                  className="px-2 py-1.5 border border-[hsl(var(--border))] rounded-lg text-xs w-full"
                  min={1} max={50} step={1} />
                <input type="number" value={config[tier.sizeKey]}
                  onChange={e => onUpdate({ [tier.sizeKey]: Number(e.target.value) })}
                  className="px-2 py-1.5 border border-[hsl(var(--border))] rounded-lg text-xs w-full"
                  min={10} max={200} step={10} />
              </div>
            ))}
            <SettingsInput label="Cooldown (hours)" value={config.dipBuyCooldownHours}
              onChange={v => onUpdate({ dipBuyCooldownHours: v })} min={1} max={168} step={1}
              help="Min hours between dip buys for same ticker" />
          </div>
        )}
      </div>

      {/* Profit Taking */}
      <div className="border-t border-[hsl(var(--border))] pt-6 mt-2">
        <div className="flex items-center gap-3 mb-4">
          <SettingsToggle
            enabled={config.profitTakeEnabled}
            onToggle={() => onUpdate({ profitTakeEnabled: !config.profitTakeEnabled })}
          />
          <div>
            <p className="text-sm font-semibold text-[hsl(var(--foreground))]">Profit Taking</p>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">Auto trim long-term positions on rallies</p>
          </div>
        </div>
        {config.profitTakeEnabled && (
          <div className="space-y-3 pl-14">
            <div className="grid grid-cols-3 gap-3">
              <div className="text-xs text-[hsl(var(--muted-foreground))] font-medium">Tier</div>
              <div className="text-xs text-[hsl(var(--muted-foreground))] font-medium">Gain %</div>
              <div className="text-xs text-[hsl(var(--muted-foreground))] font-medium">Trim %</div>
            </div>
            {[
              { label: 'Tier 1', gainKey: 'profitTakeTier1Pct' as const, trimKey: 'profitTakeTier1TrimPct' as const },
              { label: 'Tier 2', gainKey: 'profitTakeTier2Pct' as const, trimKey: 'profitTakeTier2TrimPct' as const },
              { label: 'Tier 3', gainKey: 'profitTakeTier3Pct' as const, trimKey: 'profitTakeTier3TrimPct' as const },
            ].map(tier => (
              <div key={tier.label} className="grid grid-cols-3 gap-3 items-center">
                <span className="text-xs font-medium">{tier.label}</span>
                <input type="number" value={config[tier.gainKey]}
                  onChange={e => onUpdate({ [tier.gainKey]: Number(e.target.value) })}
                  className="px-2 py-1.5 border border-[hsl(var(--border))] rounded-lg text-xs w-full"
                  min={5} max={200} step={5} />
                <input type="number" value={config[tier.trimKey]}
                  onChange={e => onUpdate({ [tier.trimKey]: Number(e.target.value) })}
                  className="px-2 py-1.5 border border-[hsl(var(--border))] rounded-lg text-xs w-full"
                  min={5} max={50} step={5} />
              </div>
            ))}
            <SettingsInput label="Min Hold %" value={config.minHoldPct}
              onChange={v => onUpdate({ minHoldPct: v })} min={10} max={80} step={5}
              help="Never sell below this % of original position" />
          </div>
        )}
      </div>

      {/* Risk Management */}
      <div className="border-t border-[hsl(var(--border))] pt-6 mt-2">
        <h4 className="text-sm font-semibold text-[hsl(var(--foreground))] mb-4">Risk Management</h4>
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <SettingsToggle enabled={config.marketRegimeEnabled}
              onToggle={() => onUpdate({ marketRegimeEnabled: !config.marketRegimeEnabled })} />
            <div>
              <p className="text-sm font-medium text-[hsl(var(--foreground))]">Market Regime Awareness</p>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Reduce sizing when VIX is high / SPY trending down</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <SettingsToggle enabled={config.earningsAvoidEnabled}
              onToggle={() => onUpdate({ earningsAvoidEnabled: !config.earningsAvoidEnabled })} />
            <div className="flex-1">
              <p className="text-sm font-medium text-[hsl(var(--foreground))]">Earnings Blackout</p>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Skip new entries near earnings announcements</p>
            </div>
            {config.earningsAvoidEnabled && (
              <input type="number" value={config.earningsBlackoutDays}
                onChange={e => onUpdate({ earningsBlackoutDays: Number(e.target.value) })}
                className="w-16 px-2 py-1.5 border border-[hsl(var(--border))] rounded-lg text-xs text-right"
                min={1} max={14} />
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SettingsInput label="Max Sector %" value={config.maxSectorPct}
              onChange={v => onUpdate({ maxSectorPct: v })} min={10} max={100} step={5}
              help="Max portfolio allocation to one sector" />
          </div>

          <div className="flex items-center gap-3">
            <SettingsToggle enabled={config.kellyAdaptiveEnabled}
              onToggle={() => onUpdate({ kellyAdaptiveEnabled: !config.kellyAdaptiveEnabled })} />
            <div>
              <p className="text-sm font-medium text-[hsl(var(--foreground))]">Adaptive Sizing (Half-Kelly)</p>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Auto-adjust sizing based on actual win rate (needs 10+ completed trades)</p>
            </div>
          </div>
        </div>
      </div>

      {/* Risk Warning */}
      <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200/70 px-4 py-3 mt-4">
        <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-sm font-medium text-amber-800">Paper Trading — Signal Quality Test</p>
          <p className="text-xs text-amber-700 mt-0.5">
            Testing AI signal quality with ${config.maxTotalAllocation.toLocaleString()} budget over 1 month.
            Orders are placed on your IB paper account with simulated money.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Settings Helper Components ───────────────────────────

function SettingsToggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={cn(
        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0',
        enabled ? 'bg-emerald-600' : 'bg-slate-300'
      )}
    >
      <span className={cn(
        'inline-block h-4 w-4 rounded-full bg-white transition-transform',
        enabled ? 'translate-x-6' : 'translate-x-1'
      )} />
    </button>
  );
}

function SettingsInput({ label, value, onChange, min, max, step, help }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  help?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-[hsl(var(--foreground))] mb-1">
        {label}
      </label>
      <input
        type="number"
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full px-2 py-1.5 border border-[hsl(var(--border))] rounded-lg text-xs"
        min={min}
        max={max}
        step={step}
      />
      {help && <p className="text-[10px] text-[hsl(var(--muted-foreground))] mt-0.5">{help}</p>}
    </div>
  );
}

// ── Smart Trading Tab ────────────────────────────────────

function SmartTradingTab({ config, regime, kellyMultiplier, totalDeployed, events, positions }: {
  config: AutoTraderConfig;
  regime: MarketRegime | null;
  kellyMultiplier: number;
  totalDeployed: number;
  events: AutoTradeEventRecord[];
  positions: IBPosition[];
}) {
  // Recent smart actions (dip buys, profit takes, blocked trades)
  const smartEvents = events.filter(e =>
    e.source === 'dip_buy' || e.source === 'profit_take' ||
    (e.skip_reason && (
      e.skip_reason.toLowerCase().includes('sector') ||
      e.skip_reason.toLowerCase().includes('earnings') ||
      e.skip_reason.toLowerCase().includes('allocation')
    ))
  );

  // Allocation
  const deployedPct = config.maxTotalAllocation > 0 ? (totalDeployed / config.maxTotalAllocation) * 100 : 0;

  // Positions with dip %
  const positionsWithDip = positions
    .filter(p => p.avgCost > 0 && p.mktPrice > 0)
    .map(p => ({
      ticker: p.contractDesc,
      shares: Math.abs(p.position),
      avgCost: p.avgCost,
      mktPrice: p.mktPrice,
      changePct: ((p.mktPrice - p.avgCost) / p.avgCost) * 100,
      unrealizedPnl: p.unrealizedPnl,
    }))
    .sort((a, b) => a.changePct - b.changePct);

  const regimeColors: Record<string, string> = {
    panic: 'text-red-600 bg-red-50 border-red-200',
    fear: 'text-amber-600 bg-amber-50 border-amber-200',
    normal: 'text-blue-600 bg-blue-50 border-blue-200',
    complacent: 'text-emerald-600 bg-emerald-50 border-emerald-200',
    disabled: 'text-slate-500 bg-slate-50 border-slate-200',
  };

  const regimeIcons: Record<string, React.ReactNode> = {
    panic: <ShieldAlert className="w-4 h-4" />,
    fear: <Shield className="w-4 h-4" />,
    normal: <ShieldCheck className="w-4 h-4" />,
    complacent: <ShieldCheck className="w-4 h-4" />,
    disabled: <Shield className="w-4 h-4" />,
  };

  return (
    <div className="space-y-4">
      {/* System Overview — 4 cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {/* Market Regime */}
        <div className={cn('rounded-xl border p-4', regimeColors[regime?.label ?? 'disabled'])}>
          <div className="flex items-center gap-2 mb-2">
            {regimeIcons[regime?.label ?? 'disabled']}
            <span className="text-xs font-medium opacity-75">Market Regime</span>
          </div>
          <p className="text-xl font-bold capitalize">{regime?.label ?? 'N/A'}</p>
          {regime?.vix != null && (
            <p className="text-[10px] mt-0.5 opacity-60">VIX: {regime.vix.toFixed(1)} &middot; {regime.multiplier.toFixed(2)}x sizing</p>
          )}
          {!config.marketRegimeEnabled && (
            <p className="text-[10px] mt-0.5 opacity-60">Disabled in settings</p>
          )}
        </div>

        {/* Kelly Multiplier */}
        <div className={cn('rounded-xl border p-4', config.kellyAdaptiveEnabled ? 'bg-violet-50 border-violet-200 text-violet-700' : 'bg-slate-50 border-slate-200 text-slate-500')}>
          <div className="flex items-center gap-2 mb-2">
            <Gauge className="w-4 h-4" />
            <span className="text-xs font-medium opacity-75">Kelly Multiplier</span>
          </div>
          <p className="text-xl font-bold">{kellyMultiplier.toFixed(2)}x</p>
          <p className="text-[10px] mt-0.5 opacity-60">
            {config.kellyAdaptiveEnabled
              ? `Half-Kelly adaptive sizing`
              : 'Disabled — using 1.0x'}
          </p>
        </div>

        {/* Allocation Cap */}
        <div className={cn('rounded-xl border p-4', deployedPct > 85 ? 'bg-red-50 border-red-200 text-red-700' : deployedPct > 60 ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-emerald-50 border-emerald-200 text-emerald-700')}>
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="w-4 h-4" />
            <span className="text-xs font-medium opacity-75">Allocation</span>
          </div>
          <p className="text-xl font-bold">{deployedPct.toFixed(0)}%</p>
          <p className="text-[10px] mt-0.5 opacity-60">
            {fmtUsd(totalDeployed, 0)} / {fmtUsd(config.maxTotalAllocation, 0)} cap
          </p>
        </div>

        {/* Dynamic Sizing */}
        <div className={cn('rounded-xl border p-4', config.useDynamicSizing ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-slate-50 border-slate-200 text-slate-500')}>
          <div className="flex items-center gap-2 mb-2">
            <BarChart3 className="w-4 h-4" />
            <span className="text-xs font-medium opacity-75">Position Sizing</span>
          </div>
          <p className="text-xl font-bold">{config.useDynamicSizing ? 'Dynamic' : 'Fixed'}</p>
          <p className="text-[10px] mt-0.5 opacity-60">
            {config.useDynamicSizing
              ? `${config.baseAllocationPct}% base, ${config.maxPositionPct}% max`
              : `$${config.positionSize.toLocaleString()} per trade`}
          </p>
        </div>
      </div>

      {/* Feature Status Grid */}
      <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))]">
          <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">Strategy Modules</h3>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-px bg-[hsl(var(--border))]">
          <FeatureCard
            label="Dip Buying"
            enabled={config.dipBuyEnabled}
            detail={config.dipBuyEnabled
              ? `Tiers: -${config.dipBuyTier1Pct}% / -${config.dipBuyTier2Pct}% / -${config.dipBuyTier3Pct}%`
              : undefined}
          />
          <FeatureCard
            label="Profit Taking"
            enabled={config.profitTakeEnabled}
            detail={config.profitTakeEnabled
              ? `Tiers: +${config.profitTakeTier1Pct}% / +${config.profitTakeTier2Pct}% / +${config.profitTakeTier3Pct}%`
              : undefined}
          />
          <FeatureCard
            label="Market Regime"
            enabled={config.marketRegimeEnabled}
            detail={regime?.vix != null ? `VIX ${regime.vix.toFixed(1)} → ${regime.multiplier.toFixed(2)}x` : undefined}
          />
          <FeatureCard
            label="Sector Limits"
            enabled={config.maxSectorPct < 100}
            detail={`Max ${config.maxSectorPct}% per sector`}
          />
          <FeatureCard
            label="Earnings Blackout"
            enabled={config.earningsAvoidEnabled}
            detail={config.earningsAvoidEnabled ? `Skip ${config.earningsBlackoutDays}d before earnings` : undefined}
          />
          <FeatureCard
            label="Kelly Adaptive"
            enabled={config.kellyAdaptiveEnabled}
            detail={config.kellyAdaptiveEnabled ? `${kellyMultiplier.toFixed(2)}x multiplier` : undefined}
          />
        </div>
      </div>

      {/* Position Heatmap — shows how close each position is to dip buy / profit take triggers */}
      {positionsWithDip.length > 0 && (
        <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))]">
            <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">Position Triggers</h3>
            <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
              How close each position is to dip buy (red) or profit take (green) thresholds
            </p>
          </div>
          <div className="divide-y divide-[hsl(var(--border))]">
            {positionsWithDip.map(p => {
              const isDip = p.changePct < 0;
              const absPct = Math.abs(p.changePct);
              // Find which tier is closest
              const nearestDipTier = isDip
                ? (absPct >= config.dipBuyTier3Pct ? 3 : absPct >= config.dipBuyTier2Pct ? 2 : absPct >= config.dipBuyTier1Pct ? 1 : 0)
                : 0;
              const nearestProfitTier = !isDip
                ? (p.changePct >= config.profitTakeTier3Pct ? 3 : p.changePct >= config.profitTakeTier2Pct ? 2 : p.changePct >= config.profitTakeTier1Pct ? 1 : 0)
                : 0;

              return (
                <div key={p.ticker} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="font-bold text-sm w-14 text-[hsl(var(--foreground))]">{p.ticker}</span>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      {/* Bar showing position relative to thresholds */}
                      <div className="flex-1 h-2 rounded-full bg-slate-100 relative overflow-hidden">
                        <div
                          className={cn(
                            'absolute top-0 h-full rounded-full transition-all',
                            isDip ? 'bg-red-400 right-1/2' : 'bg-emerald-400 left-1/2',
                          )}
                          style={{ width: `${Math.min(absPct * 2, 50)}%` }}
                        />
                        {/* Center line */}
                        <div className="absolute top-0 left-1/2 w-px h-full bg-slate-300" />
                      </div>
                    </div>
                  </div>
                  <span className={cn(
                    'text-xs font-bold tabular-nums w-16 text-right',
                    isDip ? 'text-red-600' : 'text-emerald-600'
                  )}>
                    {p.changePct >= 0 ? '+' : ''}{p.changePct.toFixed(1)}%
                  </span>
                  {nearestDipTier > 0 && config.dipBuyEnabled && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-medium">
                      Dip T{nearestDipTier}
                    </span>
                  )}
                  {nearestProfitTier > 0 && config.profitTakeEnabled && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-medium">
                      Profit T{nearestProfitTier}
                    </span>
                  )}
                  {nearestDipTier === 0 && nearestProfitTier === 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-medium w-16 text-center">
                      No trigger
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent Smart Actions */}
      {smartEvents.length > 0 && (
        <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))]">
            <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">Recent Smart Actions</h3>
          </div>
          <div className="divide-y divide-[hsl(var(--border))] max-h-64 overflow-y-auto">
            {smartEvents.slice(0, 20).map(event => (
              <div key={event.id} className="flex items-start gap-2 px-4 py-2 text-xs">
                {event.source === 'dip_buy' && <TrendingDown className="w-3.5 h-3.5 text-blue-500 mt-0.5 flex-shrink-0" />}
                {event.source === 'profit_take' && <TrendingUp className="w-3.5 h-3.5 text-emerald-500 mt-0.5 flex-shrink-0" />}
                {event.source !== 'dip_buy' && event.source !== 'profit_take' && (
                  <Shield className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <span className="font-bold text-[hsl(var(--foreground))]">{event.ticker}</span>
                  {event.action && (
                    <span className={cn('ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium', {
                      'bg-emerald-100 text-emerald-700': event.action === 'executed',
                      'bg-amber-100 text-amber-700': event.action === 'skipped',
                      'bg-red-100 text-red-700': event.action === 'failed',
                    })}>{event.source === 'dip_buy' ? 'dip buy' : event.source === 'profit_take' ? 'profit take' : 'blocked'}</span>
                  )}
                  <span className="text-[hsl(var(--muted-foreground))] ml-1.5">{event.message}</span>
                </div>
                <span className="text-[hsl(var(--muted-foreground))] flex-shrink-0 tabular-nums whitespace-nowrap">
                  {new Date(event.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {smartEvents.length === 0 && (
        <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-8 text-center">
          <Brain className="w-10 h-10 text-[hsl(var(--muted-foreground))] opacity-40 mx-auto" />
          <p className="mt-3 text-sm text-[hsl(var(--muted-foreground))]">No smart trading actions yet</p>
          <p className="text-xs text-[hsl(var(--muted-foreground))] opacity-70 mt-1">
            Dip buys, profit takes, and risk blocks will appear here
          </p>
        </div>
      )}
    </div>
  );
}

function FeatureCard({ label, enabled, detail }: { label: string; enabled: boolean; detail?: string }) {
  return (
    <div className={cn('flex items-center gap-3 px-4 py-3 bg-white')}>
      <div className={cn(
        'w-2 h-2 rounded-full flex-shrink-0',
        enabled ? 'bg-emerald-500' : 'bg-slate-300'
      )} />
      <div className="min-w-0">
        <p className={cn('text-xs font-medium', enabled ? 'text-[hsl(var(--foreground))]' : 'text-[hsl(var(--muted-foreground))]')}>
          {label}
        </p>
        {detail && <p className="text-[10px] text-[hsl(var(--muted-foreground))] truncate">{detail}</p>}
        {!enabled && !detail && <p className="text-[10px] text-[hsl(var(--muted-foreground))]">Off</p>}
      </div>
    </div>
  );
}

// ── Performance Breakdown (Signal Quality) ───────────────

function PerformanceBreakdown({ categories, totalDeployed, maxAllocation }: {
  categories: CategoryPerformance[];
  totalDeployed: number;
  maxAllocation: number;
}) {
  const sf = categories.find(c => c.category === 'suggested_finds');
  const dt = categories.find(c => c.category === 'day_trade');
  const sw = categories.find(c => c.category === 'swing_trade');
  const dipBuy = categories.find(c => c.category === 'dip_buy');
  const profitTake = categories.find(c => c.category === 'profit_take');

  const deployedPct = maxAllocation > 0 ? (totalDeployed / maxAllocation) * 100 : 0;
  const deployedColor = deployedPct < 60 ? 'bg-emerald-500' : deployedPct < 85 ? 'bg-amber-500' : 'bg-red-500';

  const hasData = categories.some(c => c.totalTrades > 0);
  if (!hasData) return null;

  return (
    <div className="space-y-3">
      {/* Allocation Meter */}
      <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-[hsl(var(--foreground))]">
            Capital Deployed
          </span>
          <span className="text-xs font-bold tabular-nums">
            ${totalDeployed.toLocaleString(undefined, { maximumFractionDigits: 0 })} / ${maxAllocation.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
        </div>
        <div className="w-full h-2.5 rounded-full bg-slate-100 overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all', deployedColor)}
            style={{ width: `${Math.min(100, deployedPct)}%` }}
          />
        </div>
        <p className="text-[10px] text-[hsl(var(--muted-foreground))] mt-1">{deployedPct.toFixed(1)}% of testing budget allocated</p>
      </div>

      {/* Signal Quality Scorecards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <SignalScorecard
          title="Suggested Finds"
          subtitle="Long-term picks"
          data={sf}
          color="indigo"
        />
        <SignalScorecard
          title="Day Trades"
          subtitle="Scanner signals"
          data={dt}
          color="blue"
        />
        <SignalScorecard
          title="Swing Trades"
          subtitle="Scanner signals"
          data={sw}
          color="violet"
        />
      </div>

      {/* Portfolio Management (dip buy + profit take) */}
      {((dipBuy?.totalTrades ?? 0) > 0 || (profitTake?.totalTrades ?? 0) > 0) && (
        <div className="flex gap-3 text-xs">
          {(dipBuy?.totalTrades ?? 0) > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-50 border border-blue-100">
              <TrendingDown className="w-3 h-3 text-blue-600" />
              <span className="text-blue-700 font-medium">Dip Buys: {dipBuy!.totalTrades}</span>
              {dipBuy!.totalPnl !== 0 && (
                <span className={cn('font-bold', dipBuy!.totalPnl > 0 ? 'text-emerald-600' : 'text-red-600')}>
                  {fmtUsd(dipBuy!.totalPnl, 0, true)}
                </span>
              )}
            </div>
          )}
          {(profitTake?.totalTrades ?? 0) > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-100">
              <TrendingUp className="w-3 h-3 text-emerald-600" />
              <span className="text-emerald-700 font-medium">Profit Takes: {profitTake!.totalTrades}</span>
              {profitTake!.totalPnl !== 0 && (
                <span className={cn('font-bold', profitTake!.totalPnl > 0 ? 'text-emerald-600' : 'text-red-600')}>
                  {fmtUsd(profitTake!.totalPnl, 0, true)}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SignalScorecard({ title, subtitle, data, color }: {
  title: string;
  subtitle: string;
  data: CategoryPerformance | undefined;
  color: 'indigo' | 'blue' | 'violet';
}) {
  const colorClasses = {
    indigo: 'border-indigo-200 bg-indigo-50',
    blue: 'border-blue-200 bg-blue-50',
    violet: 'border-violet-200 bg-violet-50',
  };
  const textColors = {
    indigo: 'text-indigo-700',
    blue: 'text-blue-700',
    violet: 'text-violet-700',
  };

  if (!data || data.totalTrades === 0) {
    return (
      <div className={cn('rounded-xl border p-4', colorClasses[color])}>
        <p className={cn('text-sm font-semibold', textColors[color])}>{title}</p>
        <p className="text-[10px] text-[hsl(var(--muted-foreground))]">{subtitle}</p>
        <p className="text-xs text-[hsl(var(--muted-foreground))] mt-3 opacity-60">No trades yet</p>
      </div>
    );
  }

  return (
    <div className={cn('rounded-xl border p-4', colorClasses[color])}>
      <div className="flex items-center justify-between mb-1">
        <div>
          <p className={cn('text-sm font-semibold', textColors[color])}>{title}</p>
          <p className="text-[10px] text-[hsl(var(--muted-foreground))]">{subtitle}</p>
        </div>
        <div className={cn('text-right')}>
          <p className={cn(
            'text-lg font-bold tabular-nums',
            data.totalPnl > 0 ? 'text-emerald-600' : data.totalPnl < 0 ? 'text-red-600' : textColors[color]
          )}>
            {fmtUsd(data.totalPnl, 0, true)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mt-3">
        <div>
          <p className="text-[10px] text-[hsl(var(--muted-foreground))]">Trades</p>
          <p className={cn('text-sm font-bold tabular-nums', textColors[color])}>{data.totalTrades}</p>
        </div>
        <div>
          <p className="text-[10px] text-[hsl(var(--muted-foreground))]">Win Rate</p>
          <p className={cn('text-sm font-bold tabular-nums', data.winRate >= 50 ? 'text-emerald-600' : 'text-red-600')}>
            {data.winRate.toFixed(0)}%
          </p>
        </div>
        <div>
          <p className="text-[10px] text-[hsl(var(--muted-foreground))]">Active</p>
          <p className={cn('text-sm font-bold tabular-nums', textColors[color])}>{data.activeTrades}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-[hsl(var(--border))]/30">
        <div>
          <p className="text-[10px] text-[hsl(var(--muted-foreground))]">Avg P&L</p>
          <p className={cn('text-xs font-bold tabular-nums', data.avgPnl >= 0 ? 'text-emerald-600' : 'text-red-600')}>
            {fmtUsd(data.avgPnl, 0, true)}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-[hsl(var(--muted-foreground))]">Avg Return</p>
          <p className={cn('text-xs font-bold tabular-nums', data.avgReturnPct >= 0 ? 'text-emerald-600' : 'text-red-600')}>
            {data.avgReturnPct >= 0 ? '+' : ''}{data.avgReturnPct.toFixed(1)}%
          </p>
        </div>
      </div>

      {(data.bestTrade || data.worstTrade) && (
        <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-[hsl(var(--border))]/30">
          {data.bestTrade && (
            <div>
              <p className="text-[10px] text-[hsl(var(--muted-foreground))]">Best</p>
              <p className="text-xs font-bold text-emerald-600 tabular-nums truncate">
                {data.bestTrade.ticker} {fmtUsd(data.bestTrade.pnl, 0, true)}
              </p>
            </div>
          )}
          {data.worstTrade && (
            <div>
              <p className="text-[10px] text-[hsl(var(--muted-foreground))]">Worst</p>
              <p className="text-xs font-bold text-red-600 tabular-nums truncate">
                {data.worstTrade.ticker} {fmtUsd(data.worstTrade.pnl, 0)}
              </p>
            </div>
          )}
        </div>
      )}
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
