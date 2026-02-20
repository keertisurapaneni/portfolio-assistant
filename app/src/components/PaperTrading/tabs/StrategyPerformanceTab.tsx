import { Fragment, useState, useEffect, useMemo, useRef } from 'react';
import { BarChart3 } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type {
  StrategySourcePerformance,
  StrategyVideoPerformance,
  StrategySignalStatusSummary,
  TradeStatus,
} from '../../../lib/paperTradesApi';
import { fixUnknownSources } from '../../../lib/strategyVideoQueueApi';
import { fmtUsd, toEtIsoDate } from '../utils';
import { StatusBadge } from '../shared';

export interface StrategyPerformanceTabProps {
  sources: StrategySourcePerformance[];
  videos: StrategyVideoPerformance[];
  statuses: StrategySignalStatusSummary[];
  onRefresh?: () => void;
}

type StrategyRow = {
  source: string;
  sourceUrl: string | null;
  videoId: string | null;
  videoHeading: string;
  strategyType: 'daily_signal' | 'generic_strategy' | null;
  applicableTimeframes: Array<'DAY_TRADE' | 'SWING_TRADE'> | null;
  totalTrades: number;
  activeTrades: number;
  winRate: number;
  avgReturnPct: number;
  totalPnl: number;
  isMarkedX: boolean;
  applicableDate: string | null;
  lastTradeAt: string | null;
  recentTrades: Array<{
    ticker: string;
    signal: 'BUY' | 'SELL';
    openedAt: string | null;
    pnl: number | null;
    pnlPercent: number | null;
    status: TradeStatus;
  }>;
  latestSignalStatus: string | null;
};

export function StrategyPerformanceTab({ sources, videos, statuses, onRefresh }: StrategyPerformanceTabProps) {
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());
  const [fixing, setFixing] = useState(false);
  const autoFixAttempted = useRef(false);

  const { todayET, isPastMarketCloseET } = useMemo(() => {
    const dateFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const timeStr = new Date().toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
    const [h, m] = timeStr.split(':').map(Number);
    const minutesSinceMidnight = (h ?? 0) * 60 + (m ?? 0);
    const parts = dateFormatter.formatToParts(new Date());
    const year = parts.find(p => p.type === 'year')?.value ?? '0000';
    const month = parts.find(p => p.type === 'month')?.value ?? '00';
    const day = parts.find(p => p.type === 'day')?.value ?? '00';
    return {
      todayET: `${year}-${month}-${day}`,
      isPastMarketCloseET: minutesSinceMidnight >= 16 * 60,
    };
  }, []);

  const sourcePerfByName = useMemo(() => {
    return new Map(sources.map(source => [source.source, source]));
  }, [sources]);

  const rowsBySource = useMemo(() => {
    const bySource = new Map<string, StrategyRow[]>();
    const statusByKey = new Map<string, StrategySignalStatusSummary>();

    for (const status of statuses) {
      const key = `${status.source}::${status.videoId ?? status.videoHeading ?? ''}`;
      statusByKey.set(key, status);
    }

    const upsertRow = (row: StrategyRow) => {
      const key = `${row.source}::${row.videoId ?? row.videoHeading}`;
      const list = bySource.get(row.source) ?? [];
      const existingIdx = list.findIndex(r => `${r.source}::${r.videoId ?? r.videoHeading}` === key);
      if (existingIdx >= 0) {
        list[existingIdx] = { ...list[existingIdx], ...row };
      } else {
        list.push(row);
      }
      bySource.set(row.source, list);
    };

    for (const video of videos) {
      const key = `${video.source}::${video.videoId ?? video.videoHeading}`;
      const status = statusByKey.get(key);
      const sourceMarkedX = sourcePerfByName.get(video.source)?.isMarkedX ?? false;
      upsertRow({
        source: video.source,
        sourceUrl: video.sourceUrl,
        videoId: video.videoId,
        videoHeading: video.videoHeading,
        strategyType: status?.strategyType ?? null,
        applicableTimeframes: status?.applicableTimeframes ?? null,
        totalTrades: video.totalTrades,
        activeTrades: video.activeTrades,
        winRate: video.winRate,
        avgReturnPct: video.avgReturnPct,
        totalPnl: video.totalPnl,
        isMarkedX: video.isMarkedX || sourceMarkedX,
        applicableDate: status?.applicableDate ?? null,
        lastTradeAt: video.lastTradeAt,
        recentTrades: video.recentTrades ?? [],
        latestSignalStatus: status?.latestSignalStatus ?? null,
      });
    }

    for (const status of statuses) {
      const key = `${status.source}::${status.videoId ?? status.videoHeading ?? ''}`;
      const hasRow = (bySource.get(status.source) ?? [])
        .some(row => `${row.source}::${row.videoId ?? row.videoHeading}` === key);
      if (hasRow) continue;

      const sourceMarkedX = sourcePerfByName.get(status.source)?.isMarkedX ?? false;
      upsertRow({
        source: status.source,
        sourceUrl: status.sourceUrl,
        videoId: status.videoId,
        videoHeading: status.videoHeading ?? status.videoId ?? 'Untitled strategy',
        strategyType: status.strategyType ?? null,
        applicableTimeframes: status.applicableTimeframes ?? null,
        totalTrades: 0,
        activeTrades: 0,
        winRate: 0,
        avgReturnPct: 0,
        totalPnl: 0,
        isMarkedX: sourceMarkedX,
        applicableDate: status.applicableDate,
        lastTradeAt: null,
        recentTrades: [],
        latestSignalStatus: status.latestSignalStatus,
      });
    }

    for (const [source, rows] of bySource.entries()) {
      const legacyRows = rows.filter(row =>
        !row.videoId && row.videoHeading.toLowerCase().startsWith('legacy strategy')
      );
      const nonLegacyRows = rows.filter(row =>
        !!row.videoId || !row.videoHeading.toLowerCase().startsWith('legacy strategy')
      );

      if (legacyRows.length > 0 && nonLegacyRows.length === 1) {
        const base = nonLegacyRows[0];
        const legacyTrades = legacyRows.reduce((sum, row) => sum + row.totalTrades, 0);
        const mergedTotalTrades = base.totalTrades + legacyTrades;
        const mergedWinRate = mergedTotalTrades > 0
          ? ((base.winRate * base.totalTrades) + legacyRows.reduce((sum, row) => sum + (row.winRate * row.totalTrades), 0)) / mergedTotalTrades
          : 0;
        const mergedAvgReturnPct = mergedTotalTrades > 0
          ? ((base.avgReturnPct * base.totalTrades) + legacyRows.reduce((sum, row) => sum + (row.avgReturnPct * row.totalTrades), 0)) / mergedTotalTrades
          : 0;
        const sortedMergedDates = [base.lastTradeAt, ...legacyRows.map(row => row.lastTradeAt)]
          .filter((v): v is string => !!v)
          .sort();
        const mergedLastTradeAt = sortedMergedDates.length > 0 ? sortedMergedDates[sortedMergedDates.length - 1] : null;
        const mergedRecentTrades = [...base.recentTrades, ...legacyRows.flatMap(row => row.recentTrades)]
          .sort((a, b) => (b.openedAt ?? '').localeCompare(a.openedAt ?? ''))
          .slice(0, 5);

        bySource.set(source, [{
          ...base,
          totalTrades: mergedTotalTrades,
          activeTrades: base.activeTrades + legacyRows.reduce((sum, row) => sum + row.activeTrades, 0),
          winRate: mergedWinRate,
          avgReturnPct: mergedAvgReturnPct,
          totalPnl: base.totalPnl + legacyRows.reduce((sum, row) => sum + row.totalPnl, 0),
          isMarkedX: base.isMarkedX || legacyRows.some(row => row.isMarkedX),
          lastTradeAt: mergedLastTradeAt,
          recentTrades: mergedRecentTrades,
        }]);
        continue;
      }

      bySource.set(source, [...rows].sort((a, b) => b.totalPnl - a.totalPnl));
    }

    return bySource;
  }, [videos, statuses, sourcePerfByName]);

  const sourceNames = useMemo(() => {
    const names = new Set<string>([...sources.map(s => s.source), ...statuses.map(s => s.source)]);
    return [...names].sort((a, b) => {
      const aPnl = sourcePerfByName.get(a)?.totalPnl ?? 0;
      const bPnl = sourcePerfByName.get(b)?.totalPnl ?? 0;
      return bPnl - aPnl;
    });
  }, [sources, statuses, sourcePerfByName]);

  const hasUnknown = sourceNames.includes('Unknown');
  useEffect(() => {
    if (!hasUnknown || autoFixAttempted.current || !onRefresh) return;
    autoFixAttempted.current = true;
    setFixing(true);
    fixUnknownSources()
      .then(({ fixed }) => {
        if (fixed > 0) onRefresh();
      })
      .finally(() => setFixing(false));
  }, [hasUnknown, onRefresh]);

  const totalTrades = sourceNames.reduce((sum, source) => {
    const perf = sourcePerfByName.get(source);
    if (perf) return sum + perf.totalTrades;
    return sum + (rowsBySource.get(source) ?? []).reduce((s, row) => s + row.totalTrades, 0);
  }, 0);
  const totalActive = sourceNames.reduce((sum, source) => {
    const perf = sourcePerfByName.get(source);
    if (perf) return sum + perf.activeTrades;
    return sum + (rowsBySource.get(source) ?? []).reduce((s, row) => s + row.activeTrades, 0);
  }, 0);
  const totalPnl = sourceNames.reduce((sum, source) => {
    const perf = sourcePerfByName.get(source);
    if (perf) return sum + perf.totalPnl;
    return sum + (rowsBySource.get(source) ?? []).reduce((s, row) => s + row.totalPnl, 0);
  }, 0);
  const markedXCount = sourceNames.filter(source => {
    const perf = sourcePerfByName.get(source);
    if (perf?.isMarkedX) return true;
    return (rowsBySource.get(source) ?? []).some(row => row.isMarkedX);
  }).length;

  const expandableSourceNames = useMemo(
    () => sourceNames.filter(source => (rowsBySource.get(source)?.length ?? 0) > 0),
    [sourceNames, rowsBySource]
  );
  const allExpanded = expandableSourceNames.length > 0 && expandableSourceNames.every(source => expandedSources.has(source));

  useEffect(() => {
    setExpandedSources(prev => {
      const next = new Set<string>();
      for (const source of prev) {
        if (sourceNames.includes(source)) next.add(source);
      }
      return next;
    });
  }, [sourceNames]);

  const getStrategyState = (row: StrategyRow): { label: string; tone: 'green' | 'amber' | 'red' } => {
    if (row.isMarkedX) return { label: 'deactivated X --', tone: 'red' };
    if (row.videoHeading.toLowerCase().startsWith('legacy strategy')) {
      return { label: 'legacy', tone: 'amber' };
    }
    const isExpired = row.strategyType === 'daily_signal' && !!row.applicableDate && (
      row.applicableDate < todayET || (row.applicableDate === todayET && isPastMarketCloseET)
    );
    if (isExpired) return { label: 'expired', tone: 'amber' };
    return { label: 'active ✓', tone: 'green' };
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <p className="text-[10px] text-blue-700/80 font-medium">Tracked Sources</p>
          <p className="text-xl font-bold text-blue-700 tabular-nums">{sourceNames.length}</p>
        </div>
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4">
          <p className="text-[10px] text-indigo-700/80 font-medium">Tracked Videos</p>
          <p className="text-xl font-bold text-indigo-700 tabular-nums">{statuses.length > videos.length ? statuses.length : videos.length}</p>
        </div>
        <div className="rounded-xl border border-cyan-200 bg-cyan-50 p-4">
          <p className="text-[10px] text-cyan-700/80 font-medium">Source Trades</p>
          <p className="text-xl font-bold text-cyan-700 tabular-nums">{totalTrades}</p>
          {totalActive > 0 && <p className="text-[10px] text-cyan-700/70">{totalActive} active</p>}
        </div>
        <div className={cn(
          'rounded-xl border p-4',
          markedXCount > 0 ? 'border-red-200 bg-red-50' : 'border-emerald-200 bg-emerald-50'
        )}>
          <p className={cn('text-[10px] font-medium', markedXCount > 0 ? 'text-red-700/80' : 'text-emerald-700/80')}>Marked X</p>
          <p className={cn('text-xl font-bold tabular-nums', markedXCount > 0 ? 'text-red-700' : 'text-emerald-700')}>{markedXCount}</p>
          {markedXCount > 0 && <p className="text-[10px] text-red-700/70">Paused after 2 consecutive losses</p>}
        </div>
        <div className={cn(
          'rounded-xl border p-4',
          totalPnl >= 0 ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'
        )}>
          <p className={cn('text-[10px] font-medium', totalPnl >= 0 ? 'text-emerald-700/80' : 'text-red-700/80')}>Total P&L</p>
          <p className={cn('text-xl font-bold tabular-nums', totalPnl >= 0 ? 'text-emerald-700' : 'text-red-700')}>
            {fmtUsd(totalPnl, 0, true)}
          </p>
        </div>
      </div>

      {sourceNames.length === 0 ? (
        <div className="rounded-xl border border-[hsl(var(--border))] bg-white p-8 text-center">
          <BarChart3 className="w-10 h-10 text-[hsl(var(--muted-foreground))] opacity-40 mx-auto" />
          <p className="mt-3 text-sm text-[hsl(var(--muted-foreground))]">No strategy-source performance yet</p>
          <p className="text-xs text-[hsl(var(--muted-foreground))] opacity-70 mt-1">
            Source-tagged auto-trades will appear here after execution.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-[hsl(var(--border))] bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary))] flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">Source Leaderboard (Drill Down by Video)</h3>
            <div className="flex items-center gap-2">
              {hasUnknown && fixing && (
                <span className="text-xs text-amber-700">Fixing Unknown sources…</span>
              )}
              {expandableSourceNames.length > 0 && (
                <button
                  onClick={() => setExpandedSources(allExpanded ? new Set() : new Set(expandableSourceNames))}
                  className="text-xs text-blue-600 hover:text-blue-700 font-medium whitespace-nowrap"
                >
                  {allExpanded ? 'Collapse all' : 'Expand all'}
                </button>
              )}
            </div>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[hsl(var(--secondary))]/50 text-[hsl(var(--muted-foreground))] text-xs">
                <th className="text-left px-4 py-2.5 font-medium">Source</th>
                <th className="text-right px-4 py-2.5 font-medium">Trades</th>
                <th className="text-right px-4 py-2.5 font-medium">Win Rate</th>
                <th className="text-right px-4 py-2.5 font-medium">Avg P&L</th>
                <th className="text-right px-4 py-2.5 font-medium">Total P&L</th>
                <th className="text-right px-4 py-2.5 font-medium">Videos</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[hsl(var(--border))]">
              {sourceNames.map(sourceName => {
                const perf = sourcePerfByName.get(sourceName);
                const sourceVideos = rowsBySource.get(sourceName) ?? [];
                const expanded = expandedSources.has(sourceName);
                const sourceUrl = perf?.sourceUrl ?? sourceVideos.find(v => v.sourceUrl)?.sourceUrl ?? null;
                const sourceIsMarkedX = perf?.isMarkedX ?? sourceVideos.some(v => v.isMarkedX);
                const sourceTrades = perf?.totalTrades ?? sourceVideos.reduce((sum, row) => sum + row.totalTrades, 0);
                const sourceActive = perf?.activeTrades ?? sourceVideos.reduce((sum, row) => sum + row.activeTrades, 0);
                const sourceWinRate = perf?.winRate ?? 0;
                const sourceAvgPnl = perf?.avgPnl ?? 0;
                const sourceTotalPnl = perf?.totalPnl ?? sourceVideos.reduce((sum, row) => sum + row.totalPnl, 0);
                const counts = sourceVideos.reduce((acc, row) => {
                  const state = getStrategyState(row);
                  if (state.tone === 'green') acc.active += 1;
                  if (state.tone === 'amber') acc.expired += 1;
                  if (state.tone === 'red') acc.deactivated += 1;
                  return acc;
                }, { active: 0, expired: 0, deactivated: 0 });

                return (
                  <Fragment key={sourceName}>
                    <tr className="hover:bg-[hsl(var(--secondary))]/50">
                      <td className="px-4 py-2.5">
                        <div className="min-w-0">
                          <p className="font-semibold truncate flex items-center gap-2">
                            <span>{sourceName}</span>
                            {sourceIsMarkedX && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700">X --</span>
                            )}
                          </p>
                          {sourceUrl && (
                            <a href={sourceUrl} target="_blank" rel="noreferrer" className="text-[10px] text-blue-600 hover:text-blue-700 truncate block">
                              {sourceUrl}
                            </a>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {sourceTrades}
                        {sourceActive > 0 && <span className="text-[10px] text-[hsl(var(--muted-foreground))] ml-1">({sourceActive} active)</span>}
                      </td>
                      <td className={cn(
                        'px-4 py-2.5 text-right tabular-nums font-medium',
                        sourceWinRate >= 50 ? 'text-emerald-600' : sourceWinRate > 0 ? 'text-red-600' : 'text-[hsl(var(--muted-foreground))]'
                      )}>
                        {sourceWinRate > 0 ? `${sourceWinRate.toFixed(0)}%` : '—'}
                      </td>
                      <td className={cn(
                        'px-4 py-2.5 text-right tabular-nums font-medium',
                        sourceAvgPnl >= 0 ? 'text-emerald-600' : 'text-red-600'
                      )}>
                        {fmtUsd(sourceAvgPnl, 0, true)}
                      </td>
                      <td className={cn(
                        'px-4 py-2.5 text-right tabular-nums font-bold',
                        sourceTotalPnl >= 0 ? 'text-emerald-600' : 'text-red-600'
                      )}>
                        {fmtUsd(sourceTotalPnl, 0, true)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {sourceVideos.length > 0 ? (
                          <div className="flex flex-col items-end">
                            <button
                              onClick={() => setExpandedSources(prev => {
                                const next = new Set(prev);
                                if (next.has(sourceName)) next.delete(sourceName);
                                else next.add(sourceName);
                                return next;
                              })}
                              className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                            >
                              {expanded ? 'Hide' : `View (${sourceVideos.length})`}
                            </button>
                            <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
                              {counts.active}✓ {counts.deactivated}x {counts.expired} exp
                            </span>
                          </div>
                        ) : (
                          <span className="text-[10px] text-[hsl(var(--muted-foreground))]">—</span>
                        )}
                      </td>
                    </tr>
                    {expanded && sourceVideos.length > 0 && (
                      <tr className="bg-[hsl(var(--secondary))]/30">
                        <td colSpan={6} className="px-4 py-3">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-[hsl(var(--muted-foreground))]">
                                <th className="text-left py-1.5 font-medium">Strategy</th>
                                <th className="text-right py-1.5 font-medium">Date</th>
                                <th className="text-right py-1.5 font-medium">Trades</th>
                                <th className="text-right py-1.5 font-medium">Win Rate</th>
                                <th className="text-right py-1.5 font-medium">Avg %</th>
                                <th className="text-right py-1.5 font-medium">Total P&L</th>
                                <th className="text-right py-1.5 font-medium">Status</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-[hsl(var(--border))]">
                              {sourceVideos.map(video => {
                                const recentTrades = [...video.recentTrades].sort((a, b) => (b.openedAt ?? '').localeCompare(a.openedAt ?? ''));
                                const displayedTrades = recentTrades.slice(0, 5);
                                const extraCount = Math.max(0, video.totalTrades - displayedTrades.length);
                                const lastTradeDate = toEtIsoDate(video.lastTradeAt);
                                const displayDate = video.totalTrades > 0
                                  ? lastTradeDate
                                  : (video.strategyType === 'daily_signal' ? video.applicableDate : null);
                                const baseKey = `${sourceName}::${video.videoId ?? video.videoHeading}`;

                                return (
                                  <Fragment key={baseKey}>
                                    <tr>
                                      <td className="py-2">
                                        <div className="min-w-0">
                                          <p className="truncate flex items-center gap-2">
                                            {video.videoHeading}
                                            {video.strategyType === 'daily_signal' && (
                                              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-800 shrink-0" title="Date-specific: only valid for applicable date">daily</span>
                                            )}
                                            {video.strategyType === 'generic_strategy' && (
                                              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-700 shrink-0" title="Ongoing: applies across dates">
                                                generic
                                                {video.applicableTimeframes && video.applicableTimeframes.length > 0 && (
                                                  <span className="ml-1 text-slate-500">
                                                    ({video.applicableTimeframes.includes('DAY_TRADE') && video.applicableTimeframes.includes('SWING_TRADE')
                                                      ? 'day + swing'
                                                      : video.applicableTimeframes.includes('DAY_TRADE')
                                                        ? 'day'
                                                        : video.applicableTimeframes.includes('SWING_TRADE')
                                                          ? 'swing'
                                                          : ''})
                                                  </span>
                                                )}
                                              </span>
                                            )}
                                          </p>
                                          {video.videoId && (
                                            <div className="flex items-center gap-2 text-[10px]">
                                              <span className="text-[hsl(var(--muted-foreground))]">{video.videoId}</span>
                                              <a href={`https://www.instagram.com/reel/${video.videoId}/`} target="_blank" rel="noreferrer" className="text-blue-600 hover:text-blue-700">Open video</a>
                                            </div>
                                          )}
                                        </div>
                                      </td>
                                      <td className="py-2 text-right tabular-nums">
                                        {displayDate ?? '—'}
                                        {video.totalTrades === 0 && video.strategyType === 'daily_signal' && video.applicableDate && (
                                          <div className="text-[10px] text-[hsl(var(--muted-foreground))]">applicable</div>
                                        )}
                                      </td>
                                      <td className="py-2 text-right tabular-nums">
                                        {video.totalTrades}
                                        {extraCount > 0 && <p className="text-[10px] text-[hsl(var(--muted-foreground))] mt-0.5">+{extraCount} older</p>}
                                      </td>
                                      <td className={cn(
                                        'py-2 text-right tabular-nums font-medium',
                                        video.winRate >= 50 ? 'text-emerald-600' : video.winRate > 0 ? 'text-red-600' : 'text-[hsl(var(--muted-foreground))]'
                                      )}>
                                        {video.winRate > 0 ? `${video.winRate.toFixed(0)}%` : '—'}
                                      </td>
                                      <td className={cn('py-2 text-right tabular-nums', video.avgReturnPct >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                                        {video.avgReturnPct >= 0 ? '+' : ''}{video.avgReturnPct.toFixed(2)}%
                                      </td>
                                      <td className={cn('py-2 text-right tabular-nums font-semibold', video.totalPnl >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                                        {fmtUsd(video.totalPnl, 0, true)}
                                      </td>
                                      <td className="py-2 text-right">
                                        {(() => {
                                          const state = getStrategyState(video);
                                          const badgeClass = state.tone === 'green' ? 'bg-emerald-100 text-emerald-700'
                                            : state.tone === 'amber' ? 'bg-amber-100 text-amber-700'
                                            : 'bg-red-100 text-red-700';
                                          return (
                                            <div className="flex flex-col items-end">
                                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${badgeClass}`}>{state.label}</span>
                                              {video.latestSignalStatus && (
                                                <span className="text-[10px] text-[hsl(var(--muted-foreground))] mt-0.5">{video.latestSignalStatus}</span>
                                              )}
                                            </div>
                                          );
                                        })()}
                                      </td>
                                    </tr>
                                    {displayedTrades.map((trade, idx) => (
                                      <tr key={`${baseKey}::trade-${idx}`} className="bg-white/60">
                                        <td className="py-1.5 pl-6">
                                          <div className="flex items-center gap-1.5">
                                            <span className="text-[hsl(var(--muted-foreground))]">↳</span>
                                            <span className="font-medium">{trade.ticker}</span>
                                            <span className={cn(
                                              'inline-flex px-1 py-0.5 rounded text-[9px] font-bold',
                                              trade.signal === 'BUY' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                                            )}>
                                              {trade.signal}
                                            </span>
                                          </div>
                                        </td>
                                        <td className="py-1.5 text-right tabular-nums">{toEtIsoDate(trade.openedAt) ?? '—'}</td>
                                        <td className="py-1.5 text-right tabular-nums">{idx + 1}</td>
                                        <td className="py-1.5 text-right text-[hsl(var(--muted-foreground))]">—</td>
                                        <td className={cn(
                                          'py-1.5 text-right tabular-nums font-medium',
                                          (trade.pnlPercent ?? 0) > 0 ? 'text-emerald-600' : (trade.pnlPercent ?? 0) < 0 ? 'text-red-600' : 'text-[hsl(var(--muted-foreground))]'
                                        )}>
                                          {trade.pnlPercent == null ? '—' : `${trade.pnlPercent >= 0 ? '+' : ''}${trade.pnlPercent.toFixed(2)}%`}
                                        </td>
                                        <td className={cn(
                                          'py-1.5 text-right tabular-nums font-semibold',
                                          (trade.pnl ?? 0) > 0 ? 'text-emerald-600' : (trade.pnl ?? 0) < 0 ? 'text-red-600' : 'text-[hsl(var(--muted-foreground))]'
                                        )}>
                                          {trade.pnl == null ? 'Open' : fmtUsd(trade.pnl, 2, true)}
                                        </td>
                                        <td className="py-1.5 text-right">
                                          <StatusBadge status={trade.status} />
                                        </td>
                                      </tr>
                                    ))}
                                  </Fragment>
                                );
                              })}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
