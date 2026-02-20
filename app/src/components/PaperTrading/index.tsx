import { useState, useEffect, useCallback, useMemo } from 'react';
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
import { getAccounts, getPositions, getLiveOrders, type IBPosition, type IBLiveOrder } from '../../lib/ibClient';
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
  getAutoTradeEvents,
  getTodaysExecutedEvents,
  getDayTradeValidationReport,
  getSwingTradeValidationReport,
} from '../../lib/paperTradesApi';
import { getTotalDeployed, getMarketRegime, calculateKellyMultiplier, type MarketRegime } from '../../lib/autoTrader';
import { Spinner } from '../Spinner';
import { analyzeUnreviewedTrades, updatePerformancePatterns } from '../../lib/aiFeedback';
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

export function PaperTrading() {
  const [config, setConfig] = useState<AutoTraderConfig>(getAutoTraderConfig);
  const [connected, setConnected] = useState(isIBConnected());
  const [events, setEvents] = useState<AutoTradeEvent[]>(getEventLog());
  const [allTrades, setAllTrades] = useState<PaperTrade[]>([]);
  const [performance, setPerformance] = useState<TradePerformance | null>(null);
  const [ibPositions, setIbPositions] = useState<IBPosition[]>([]);
  const [ibOrders, setIbOrders] = useState<IBLiveOrder[]>([]);
  const [persistedEvents, setPersistedEvents] = useState<AutoTradeEventRecord[]>([]);
  const [todaysExecuted, setTodaysExecuted] = useState<AutoTradeEventRecord[]>([]);
  const [categoryPerf, setCategoryPerf] = useState<CategoryPerformance[]>([]);
  const [sourcePerf, setSourcePerf] = useState<StrategySourcePerformance[]>([]);
  const [videoPerf, setVideoPerf] = useState<StrategyVideoPerformance[]>([]);
  const [strategyStatuses, setStrategyStatuses] = useState<StrategySignalStatusSummary[]>([]);
  const [pendingSignals, setPendingSignals] = useState<PendingStrategySignal[]>([]);
  const [validationReport, setValidationReport] = useState<DayTradeValidationReport | null>(null);
  const [swingValidationReport, setSwingValidationReport] = useState<SwingTradeValidationReport | null>(null);
  const [totalDeployed, setTotalDeployed] = useState(0);
  const [marketRegime, setMarketRegime] = useState<MarketRegime | null>(null);
  const [kellyMultiplier, setKellyMultiplier] = useState<number>(1.0);
  const [tab, setTab] = useState<Tab>('portfolio');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [all, perf, savedEvents, todayEvents, catPerf, srcPerf, vidPerf, signalStatuses, pending, deployed, regime, kelly, validation, swingValidation] = await Promise.all([
        getAllTrades(50),
        getPerformance(),
        getAutoTradeEvents(100),
        getTodaysExecutedEvents(),
        recalculatePerformanceByCategory(),
        recalculatePerformanceByStrategySource(),
        recalculatePerformanceByStrategyVideo(),
        getStrategySignalStatusSummaries(),
        getPendingStrategySignals(300),
        getTotalDeployed(),
        getMarketRegime(config),
        calculateKellyMultiplier(config),
        getDayTradeValidationReport(),
        getSwingTradeValidationReport(),
      ]);
      setAllTrades(all);
      setPerformance(perf);
      setPersistedEvents(savedEvents);
      setTodaysExecuted(todayEvents);
      setCategoryPerf(catPerf);
      setSourcePerf(srcPerf);
      setVideoPerf(vidPerf);
      setStrategyStatuses(signalStatuses);
      setPendingSignals(pending);
      setTotalDeployed(deployed);
      setMarketRegime(regime);
      setKellyMultiplier(kelly);
      setValidationReport(validation);
      setSwingValidationReport(swingValidation);
    } catch (err) {
      console.error('Failed to load paper trading data:', err);
    } finally {
      setLoading(false);
    }
  }, [config]);

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

  useEffect(() => {
    loadAutoTraderConfig().then(setConfig);
  }, []);

  useEffect(() => {
    analyzeUnreviewedTrades()
      .then(count => {
        if (count > 0) {
          console.log(`[PaperTrading] Analyzed ${count} new trades`);
          updatePerformancePatterns().catch(console.error);
          loadData();
        }
      })
      .catch(console.error);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      const key = `${e.ticker}|${signal}`;
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

  const totalCostBasis = ibPositions.reduce((sum, p) => sum + Math.abs(p.position) * p.avgCost, 0);
  const totalMktValue = ibPositions.reduce((sum, p) => sum + p.mktValue, 0);
  const totalUnrealizedPnl = ibPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
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

      <div className="flex gap-1 bg-white/60 p-1 rounded-xl border border-[hsl(var(--border))]">
        {[
          { id: 'portfolio' as Tab, label: 'IB Portfolio', icon: Briefcase, count: ibPositions.length },
          { id: 'today' as Tab, label: "Today's Activity", icon: Zap, count: dedupedToday.length },
          { id: 'history' as Tab, label: 'Trade History', icon: Clock, count: allTrades.length },
          { id: 'performance' as Tab, label: 'Performance', icon: BarChart2 },
          { id: 'strategies' as Tab, label: 'Strategy Perf', icon: BarChart3, count: sourcePerf.length },
          { id: 'validation' as Tab, label: 'Trade Validation', icon: ClipboardCheck },
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
              pendingSignals={pendingSignals}
              connected={connected}
              onRefresh={loadIBData}
            />
          )}
          {tab === 'today' && (
            <TodayActivityTab events={dedupedToday} trades={allTrades} />
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
          {tab === 'strategies' && (
            <StrategyPerformanceTab sources={sourcePerf} videos={videoPerf} statuses={strategyStatuses} onRefresh={loadData} />
          )}
          {tab === 'validation' && (
            <ValidationTab
              dayReport={validationReport}
              swingReport={swingValidationReport}
              onRefresh={loadData}
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
