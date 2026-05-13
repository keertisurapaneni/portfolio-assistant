import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Bot,
  Wifi,
  WifiOff,
  Play,
  Pause,
  RefreshCw,
  DollarSign,
  Target,
  Briefcase,
  BarChart3,
  Zap,
  Clock,
  Activity,
  ClipboardCheck,
  Brain,
  Settings,
  BarChart2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  TrendingUp,
} from 'lucide-react';
import { cn } from '../../lib/utils';
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
} from '../../lib/autoTrader';
import { getAccounts, getPositions, getLiveOrders, getAccountPnL, type IBPosition, type IBLiveOrder, type AccountPnL } from '../../lib/ibClient';
import {
  type PaperTrade,
  type TradePerformance,
  type AutoTradeEventRecord,
  type CategoryPerformance,
  type StrategySourcePerformance,
  type StrategyVideoPerformance,
  type StrategySignalStatusSummary,
  type PendingStrategySignal,
  type DayTradeValidationReport,
  type SwingTradeValidationReport,
  getAllTrades,
  getPerformance,
  recalculatePerformance,
  recalculatePerformanceByCategory,
  recalculatePerformanceByStrategySource,
  recalculatePerformanceByStrategyVideo,
  getStrategySignalStatusSummaries,
  getPendingStrategySignals,
  getTodaySignalsForManualExecute,
  getAutoTradeEvents,
  getTodaysExecutedEvents,
  getDayTradeValidationReport,
  getSwingTradeValidationReport,
  clearSharedTradesCache,
} from '../../lib/paperTradesApi';
import { getTotalDeployed, getMarketRegime, calculateKellyMultiplier, type MarketRegime } from '../../lib/autoTrader';
import { Spinner } from '../Spinner';
import { fmtUsd } from './utils';
import { StatCard } from './shared';
import {
  PortfolioTab,
  TodayActivityTab,
  HistoryTab,
  SmartTradingTab,
  SettingsTab,
  ValidationTab,
  StrategyPerformanceTab,
  PerformanceTab,
} from './tabs';

export type Tab = 'portfolio' | 'today' | 'smart' | 'strategies' | 'validation' | 'history' | 'performance' | 'settings';

// Module-level cache: survives unmount so navigating back is instant
const PAGE_CACHE_TTL = 2 * 60 * 1000; // 2 minutes
interface PageCache {
  ts: number;
  performance: TradePerformance | null;
  persistedEvents: AutoTradeEventRecord[];
  todaysExecuted: AutoTradeEventRecord[];
  ibPositions: IBPosition[];
  ibOrders: IBLiveOrder[];
  allTrades: PaperTrade[];
  pendingSignals: PendingStrategySignal[];
  todaySignalsForExecute: PendingStrategySignal[];
  categoryPerf: CategoryPerformance[];
  sourcePerf: StrategySourcePerformance[];
  videoPerf: StrategyVideoPerformance[];
  strategyStatuses: StrategySignalStatusSummary[];
  validationReport: DayTradeValidationReport | null;
  swingValidationReport: SwingTradeValidationReport | null;
  totalDeployed: number;
  marketRegime: MarketRegime | null;
  kellyMultiplier: number;
  lastCycleSummary: string[];
  ibAccountPnl: AccountPnL | null;
  fetchedGroups: string[];
}
let _pageCache: PageCache | null = null;

export function PaperTrading() {
  const cached = _pageCache && Date.now() - _pageCache.ts < PAGE_CACHE_TTL ? _pageCache : null;

  const [config, setConfig] = useState<AutoTraderConfig>(getAutoTraderConfig);
  const [connected, setConnected] = useState(isIBConnected());
  const [events, setEvents] = useState<AutoTradeEvent[]>(getEventLog());
  const [allTrades, setAllTrades] = useState<PaperTrade[]>(cached?.allTrades ?? []);
  const [performance, setPerformance] = useState<TradePerformance | null>(cached?.performance ?? null);
  const [ibPositions, setIbPositions] = useState<IBPosition[]>(cached?.ibPositions ?? []);
  const [ibOrders, setIbOrders] = useState<IBLiveOrder[]>(cached?.ibOrders ?? []);
  const [persistedEvents, setPersistedEvents] = useState<AutoTradeEventRecord[]>(cached?.persistedEvents ?? []);
  const [todaysExecuted, setTodaysExecuted] = useState<AutoTradeEventRecord[]>(cached?.todaysExecuted ?? []);
  const [categoryPerf, setCategoryPerf] = useState<CategoryPerformance[]>(cached?.categoryPerf ?? []);
  const [sourcePerf, setSourcePerf] = useState<StrategySourcePerformance[]>(cached?.sourcePerf ?? []);
  const [videoPerf, setVideoPerf] = useState<StrategyVideoPerformance[]>(cached?.videoPerf ?? []);
  const [strategyStatuses, setStrategyStatuses] = useState<StrategySignalStatusSummary[]>(cached?.strategyStatuses ?? []);
  const [pendingSignals, setPendingSignals] = useState<PendingStrategySignal[]>(cached?.pendingSignals ?? []);
  const [todaySignalsForExecute, setTodaySignalsForExecute] = useState<PendingStrategySignal[]>(cached?.todaySignalsForExecute ?? []);
  const [validationReport, setValidationReport] = useState<DayTradeValidationReport | null>(cached?.validationReport ?? null);
  const [swingValidationReport, setSwingValidationReport] = useState<SwingTradeValidationReport | null>(cached?.swingValidationReport ?? null);
  const [totalDeployed, setTotalDeployed] = useState(cached?.totalDeployed ?? 0);
  const [lastCycleSummary, setLastCycleSummary] = useState<string[]>(cached?.lastCycleSummary ?? []);
  const [ibAccountPnl, setIbAccountPnl] = useState<AccountPnL | null>(cached?.ibAccountPnl ?? null);
  const [marketRegime, setMarketRegime] = useState<MarketRegime | null>(cached?.marketRegime ?? null);
  const [kellyMultiplier, setKellyMultiplier] = useState<number>(cached?.kellyMultiplier ?? 1.0);
  const [tab, setTab] = useState<Tab>('portfolio');
  const [loading, setLoading] = useState(!cached);
  const [tabLoading, setTabLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Track which data groups have been fetched so we don't re-fetch on tab switch
  const fetchedRef = useRef(new Set<string>(cached?.fetchedGroups ?? []));
  const configRef = useRef(config);
  useEffect(() => { configRef.current = config; }, [config]);

  // Refs for cache snapshot on unmount
  const stateRef = useRef({
    performance, persistedEvents, todaysExecuted, ibPositions, ibOrders,
    allTrades, pendingSignals, todaySignalsForExecute, categoryPerf,
    sourcePerf, videoPerf, strategyStatuses, validationReport,
    swingValidationReport, totalDeployed, marketRegime, kellyMultiplier, lastCycleSummary,
    ibAccountPnl,
  });
  useEffect(() => {
    stateRef.current = {
      performance, persistedEvents, todaysExecuted, ibPositions, ibOrders,
      allTrades, pendingSignals, todaySignalsForExecute, categoryPerf,
      sourcePerf, videoPerf, strategyStatuses, validationReport,
      swingValidationReport, totalDeployed, marketRegime, kellyMultiplier, lastCycleSummary,
      ibAccountPnl,
    };
  });
  useEffect(() => {
    return () => {
      _pageCache = { ts: Date.now(), ...stateRef.current, fetchedGroups: [...fetchedRef.current] };
    };
  }, []);

  // ── Core data: header stats + activity log (always visible) ──
  const loadCoreData = useCallback(async () => {
    const [perf, savedEvents, todayEvents] = await Promise.all([
      getPerformance(),
      getAutoTradeEvents(100),
      getTodaysExecutedEvents(),
    ]);
    setPerformance(perf);
    setPersistedEvents(savedEvents);
    setTodaysExecuted(todayEvents);
    fetch('http://localhost:3001/api/scheduler/status')
      .then((r) => r.json())
      .then((d) => setLastCycleSummary(d.lastCycleSummary ?? []))
      .catch(() => setLastCycleSummary([]));
  }, []);

  // ── IB data: positions + orders + account P&L for header stats ──
  const loadIBData = useCallback(async () => {
    if (!connected) return;
    try {
      const [positions, orders, pnl] = await Promise.all([
        getPositions(config.accountId ?? ''),
        getLiveOrders(),
        getAccountPnL(),
      ]);
      setIbPositions(positions);
      setIbOrders(orders);
      setIbAccountPnl(pnl);
    } catch (err) {
      console.error('Failed to load IB data:', err);
    }
  }, [connected, config.accountId]);

  // ── Tab-specific data: loaded lazily on first visit, cached ──
  const TAB_GROUPS: Record<Tab, string[]> = useMemo(() => ({
    portfolio:   ['pendingSignals'],
    today:       ['allTrades', 'todaySignals'],
    history:     ['allTrades', 'pendingSignals'],
    performance: ['categoryPerf', 'totalDeployed'],
    strategies:  ['strategyPerf'],
    validation:  ['validationReports'],
    smart:       ['totalDeployed', 'smartTrading'],
    settings:    [],
  }), []);

  const loadTabData = useCallback(async (t: Tab, force = false) => {
    const groups = TAB_GROUPS[t];
    const needed = force ? groups : groups.filter(g => !fetchedRef.current.has(g));
    if (needed.length === 0) return;

    setTabLoading(true);
    try {
      const promises: Promise<void>[] = [];
      for (const group of needed) {
        switch (group) {
          case 'allTrades':
            promises.push(getAllTrades(500).then(d => { setAllTrades(d); }));
            break;
          case 'pendingSignals':
            promises.push(getPendingStrategySignals(300).then(d => { setPendingSignals(d); }));
            break;
          case 'todaySignals':
            promises.push(getTodaySignalsForManualExecute().then(d => { setTodaySignalsForExecute(d); }));
            break;
          case 'categoryPerf':
            promises.push(recalculatePerformanceByCategory().then(d => { setCategoryPerf(d); }));
            break;
          case 'totalDeployed':
            promises.push(getTotalDeployed().then(d => { setTotalDeployed(d); }));
            break;
          case 'strategyPerf':
            promises.push(Promise.all([
              recalculatePerformanceByStrategySource().then(d => { setSourcePerf(d); }),
              recalculatePerformanceByStrategyVideo().then(d => { setVideoPerf(d); }),
              getStrategySignalStatusSummaries().then(d => { setStrategyStatuses(d); }),
            ]).then(() => {}));
            break;
          case 'validationReports':
            promises.push(Promise.all([
              getDayTradeValidationReport().then(d => { setValidationReport(d); }),
              getSwingTradeValidationReport().then(d => { setSwingValidationReport(d); }),
            ]).then(() => {}));
            break;
          case 'smartTrading':
            promises.push(Promise.all([
              getMarketRegime(configRef.current).then(d => { setMarketRegime(d); }),
              calculateKellyMultiplier(configRef.current).then(d => { setKellyMultiplier(d); }),
            ]).then(() => {}));
            break;
        }
        fetchedRef.current.add(group);
      }
      await Promise.all(promises);
    } finally {
      setTabLoading(false);
    }
  }, [TAB_GROUPS]);

  // ── Mount: load core + IB + initial tab in parallel (skip if cache is fresh) ──
  useEffect(() => {
    if (cached) return;
    let mounted = true;
    (async () => {
      setLoading(true);
      try {
        await Promise.all([loadCoreData(), loadIBData(), loadTabData('portfolio')]);
      } catch (err) {
        console.error('Failed to load paper trading data:', err);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-load IB data when connection or account changes
  useEffect(() => { loadIBData(); }, [loadIBData]);

  useEffect(() => { loadAutoTraderConfig().then(setConfig); }, []);

  // Load tab data lazily when the user switches tabs
  useEffect(() => {
    if (loading) return;
    loadTabData(tab);
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const unsub = onConnectionChange(setConnected);
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onEventLogChange(setEvents);
    return unsub;
  }, []);

  useEffect(() => {
    startSessionPing();
    if (config.enabled) {
      scheduleDayTradeAutoClose(config);
    }
    return () => stopSessionPing();
  }, [config.enabled]);

  const handleToggle = async () => {
    if (!config.enabled && !config.accountId) {
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

  // Full refresh: clear all caches, reload core + current tab
  const handleSync = async () => {
    setSyncing(true);
    fetchedRef.current.clear();
    clearSharedTradesCache();
    _pageCache = null;
    try {
      if (config.accountId) {
        await syncPositions(config.accountId);
        await recalculatePerformance();
      }
      await Promise.all([loadCoreData(), loadIBData()]);
      await loadTabData(tab, true);
    } catch (err) {
      console.error('Sync failed:', err);
    } finally {
      setSyncing(false);
    }
  };

  // Refresh after executing a signal or action (reloads core + current tab data)
  const refreshAfterAction = useCallback(async () => {
    fetchedRef.current.delete('allTrades');
    fetchedRef.current.delete('todaySignals');
    clearSharedTradesCache();
    await Promise.all([loadCoreData(), loadIBData()]);
    await loadTabData(tab, true);
  }, [loadCoreData, loadIBData, loadTabData, tab]);

  const updateConfig = async (updates: Partial<AutoTraderConfig>) => {
    const updated = await saveAutoTraderConfig(updates);
    setConfig(updated);
  };

  const dedupedToday = useMemo(() => {
    const executions = todaysExecuted.filter(e => !(e.source === 'system' && !e.mode));
    const systemCloses = todaysExecuted.filter(e => e.source === 'system' && !e.mode);
    const executedTickers = new Set(executions.map(e => e.ticker));
    const uniqueCloses = systemCloses.filter(sc => !executedTickers.has(sc.ticker));

    const finalExecs: AutoTradeEventRecord[] = [];
    const seen = new Map<string, number>();
    for (const e of executions) {
      const signal = (e.scanner_signal ?? 'BUY').toUpperCase();
      const key = `${e.ticker}|${signal}|${e.action ?? 'executed'}`;
      const existingIdx = seen.get(key);
      if (existingIdx != null) {
        const existing = finalExecs[existingIdx];
        if (new Date(e.created_at) > new Date(existing.created_at)) {
          finalExecs[existingIdx] = e;
        }
        continue;
      }
      seen.set(key, finalExecs.length);
      finalExecs.push(e);
    }
    return [...finalExecs, ...uniqueCloses].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  }, [todaysExecuted]);

  // Only include equity (stock) positions in the header stats.
  // Options positions report avgCost as a per-contract premium value, while mktPrice is
  // the underlying stock price — mixing them produces wildly wrong cost basis / market value.
  // Options are tracked separately in the Options tab.
  const equityPositions = ibPositions.filter(p => !p.secType || p.secType === 'STK');
  const optionPositionCount = ibPositions.filter(p => p.secType === 'OPT').length;

  // Only include positions where we actually got a real market price.
  // Positions with mktPrice = 0 (Finnhub rate-limited or symbol unknown) would inflate
  // cost basis while contributing $0 to market value, creating a phantom loss gap.
  const pricedEquityPositions = equityPositions.filter(p => p.mktPrice > 0);
  const unpricedCount = equityPositions.length - pricedEquityPositions.length;

  const longPositions = pricedEquityPositions.filter(p => p.position > 0);
  const shortPositions = pricedEquityPositions.filter(p => p.position < 0);

  // Gross values for display (face value of each position, regardless of direction)
  const longCostBasis  = longPositions.reduce((sum, p)  => sum + Math.abs(p.position) * p.avgCost, 0);
  const shortCostBasis = shortPositions.reduce((sum, p) => sum + Math.abs(p.position) * p.avgCost, 0);
  const longMktValue   = longPositions.reduce((sum, p)  => sum + p.mktValue, 0);
  const shortMktValue  = shortPositions.reduce((sum, p) => sum + p.mktValue, 0);

  // Shown in header cards — gross exposure (both sides positive, for size context)
  const totalCostBasis = longCostBasis + shortCostBasis;
  const totalMktValue  = longMktValue  + shortMktValue;

  // Use IB's own unrealized P&L (from reqPnL) when available — it includes all
  // asset types (stocks + options) and matches what the IB mobile app shows.
  // Fall back to equity-only calculation when IB data isn't available.
  const equityUnrealizedPnl = pricedEquityPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const totalUnrealizedPnl = ibAccountPnl?.unrealizedPnL ?? equityUnrealizedPnl;
  const uniqueOrderTickers = new Set(ibOrders.map(o => o.ticker)).size;

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[hsl(var(--foreground))]">Paper Trading</h1>
            <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">
              Auto-execute scanner signals on IB paper account
            </p>
          </div>
          <div className="flex items-center gap-3">
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

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard
          icon={<Briefcase className="w-4 h-4" />}
          label="Holdings"
          value={String(equityPositions.length)}
          subtitle={
            unpricedCount > 0
              ? `${unpricedCount} unpriced (rate limit)`
              : optionPositionCount > 0
                ? `+${optionPositionCount} option${optionPositionCount > 1 ? 's' : ''} • ${uniqueOrderTickers > 0 ? `${uniqueOrderTickers} order${uniqueOrderTickers > 1 ? 's' : ''}` : 'no orders'}`
                : uniqueOrderTickers > 0 ? `${uniqueOrderTickers} open order${uniqueOrderTickers > 1 ? 's' : ''}` : undefined
          }
          color={unpricedCount > 0 ? 'red' : 'blue'}
        />
        <StatCard
          icon={<DollarSign className="w-4 h-4" />}
          label="Cost Basis"
          value={connected && totalCostBasis > 0 ? `$${totalCostBasis.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'}
          subtitle={shortPositions.length > 0 ? `Longs $${Math.round(longCostBasis / 1000)}k · Shorts $${Math.round(shortCostBasis / 1000)}k` : undefined}
          color="blue"
        />
        <StatCard
          icon={<BarChart3 className="w-4 h-4" />}
          label="Market Value"
          value={connected && totalMktValue > 0 ? `$${totalMktValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'}
          subtitle={shortPositions.length > 0 ? `Longs $${Math.round(longMktValue / 1000)}k · Shorts $${Math.round(shortMktValue / 1000)}k` : undefined}
          color={totalUnrealizedPnl >= 0 ? 'green' : 'red'}
        />
        <StatCard
          icon={<TrendingUp className="w-4 h-4" />}
          label="Unrealized P&L"
          value={connected && totalMktValue > 0 ? fmtUsd(totalUnrealizedPnl, 0, true) : '—'}
          subtitle={ibAccountPnl?.realizedPnL != null
            ? `Today Realized: ${fmtUsd(ibAccountPnl.realizedPnL, 0, true)}`
            : `All-Time: ${fmtUsd(performance?.total_pnl ?? 0, 0, true)}`}
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

      {/* Tab bar — horizontally scrollable on mobile */}
      <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
        <div className="flex gap-1 bg-white/60 p-1 rounded-xl border border-[hsl(var(--border))] w-max sm:w-auto min-w-full">
          {[
            { id: 'portfolio' as Tab,   label: 'IB Portfolio',    short: 'Portfolio',   icon: Briefcase,     count: ibPositions.length },
            { id: 'today' as Tab,       label: "Today's Activity", short: 'Today',       icon: Zap,           count: dedupedToday.length },
            { id: 'history' as Tab,     label: 'Trade History',    short: 'History',     icon: Clock,         count: allTrades.length },
            { id: 'performance' as Tab, label: 'Performance',      short: 'Perf',        icon: BarChart2 },
            { id: 'strategies' as Tab,  label: 'Influencers',      short: 'Influencers', icon: BarChart3,     count: sourcePerf.length },
            { id: 'validation' as Tab,  label: 'System Learning', short: 'Learning',    icon: ClipboardCheck },
            { id: 'smart' as Tab,       label: 'Smart Trading',    short: 'Smart',       icon: Brain },
            { id: 'settings' as Tab,    label: 'Settings',         short: 'Settings',    icon: Settings },
          ].map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap flex-shrink-0',
                tab === t.id
                  ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md'
                  : 'text-slate-500 hover:text-slate-700 hover:bg-white/80'
              )}
            >
              <t.icon className="w-4 h-4 flex-shrink-0" />
              <span className="hidden sm:inline">{t.label}</span>
              <span className="sm:hidden">{t.short}</span>
              {t.count !== undefined && t.count > 0 && (
                <span className={cn(
                  'px-1.5 py-0.5 text-xs rounded-full font-semibold',
                  tab === t.id ? 'bg-white/25' : 'bg-slate-100'
                )}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner size="lg" />
        </div>
      ) : tabLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner size="md" />
        </div>
      ) : (
        <>
          {tab === 'portfolio' && (
            <PortfolioTab
              positions={ibPositions}
              orders={ibOrders}
              pendingSignals={pendingSignals}
              connected={connected}
              onRefresh={loadIBData}
            />
          )}
          {tab === 'today' && (
            <TodayActivityTab
              events={dedupedToday}
              trades={allTrades}
              todaySignalsForExecute={todaySignalsForExecute}
              onExecuteSignal={refreshAfterAction}
              ibRealizedPnl={ibAccountPnl?.realizedPnL ?? null}
            />
          )}
          {tab === 'smart' && (
            <SmartTradingTab
              config={config}
              regime={marketRegime}
              kellyMultiplier={kellyMultiplier}
              totalDeployed={totalDeployed}
              events={persistedEvents}
              positions={ibPositions}
              lastCycleSummary={lastCycleSummary}
            />
          )}
          {tab === 'strategies' && (
            <StrategyPerformanceTab sources={sourcePerf} videos={videoPerf} statuses={strategyStatuses} onRefresh={() => loadTabData('strategies', true)} />
          )}
          {tab === 'validation' && (
            <ValidationTab
              dayReport={validationReport}
              swingReport={swingValidationReport}
              onRefresh={() => loadTabData('validation', true)}
            />
          )}
          {tab === 'history' && (
            <HistoryTab trades={allTrades} pendingSignals={pendingSignals} />
          )}
          {tab === 'performance' && (
            <PerformanceTab
              categories={categoryPerf}
              totalDeployed={totalDeployed}
              maxAllocation={config.maxTotalAllocation}
            />
          )}
          {tab === 'settings' && (
            <SettingsTab config={config} onUpdate={updateConfig} />
          )}
        </>
      )}

      {(events.length > 0 || persistedEvents.length > 0) && (
        <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))] flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">Activity Log</h3>
            {persistedEvents.length > 0 && (
              <span className="text-xs text-[hsl(var(--muted-foreground))]">{persistedEvents.length} saved events</span>
            )}
          </div>
          <div className="max-h-64 overflow-y-auto divide-y divide-[hsl(var(--border))]">
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
            {persistedEvents
              .filter(e => e.action)
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
                  {event.strategy_source && (
                    <span className="text-[hsl(var(--muted-foreground))] ml-1.5 opacity-70">
                      [{event.strategy_source}]
                    </span>
                  )}
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
