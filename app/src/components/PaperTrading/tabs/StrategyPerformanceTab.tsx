import { Fragment, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { BarChart3, Link2, Plus, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type {
  StrategySourcePerformance,
  StrategyVideoPerformance,
  StrategySignalStatusSummary,
  TradeStatus,
} from '../../../lib/paperTradesApi';
import {
  fixUnknownSources, assignUnknownToSource, updateStrategyVideoMetadata,
  extractFromTranscript, cleanupStrategyAssignments, fetchYouTubeTranscript,
  addUrlsToQueue, processQueue, getQueue, type StrategyVideoQueueItem,
} from '../../../lib/strategyVideoQueueApi';
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
  platform: 'instagram' | 'twitter' | 'youtube' | null;
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
  transcript?: string | null;
  ingestStatus?: 'pending' | 'transcribing' | 'done' | 'failed' | null;
  ingestError?: string | null;
};

export function StrategyPerformanceTab({ sources, videos, statuses, onRefresh }: StrategyPerformanceTabProps) {
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());
  const [expandedTranscript, setExpandedTranscript] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [assigningVideoId, setAssigningVideoId] = useState<string | null>(null);
  const [updatingCategoryVideoId, setUpdatingCategoryVideoId] = useState<string | null>(null);
  const [pasteTranscriptVideoId, setPasteTranscriptVideoId] = useState<string | null>(null);
  const [pasteTranscriptText, setPasteTranscriptText] = useState('');
  const [extractingVideoId, setExtractingVideoId] = useState<string | null>(null);
  const [fetchingCaptionsVideoId, setFetchingCaptionsVideoId] = useState<string | null>(null);
  const [videoAssignSelections, setVideoAssignSelections] = useState<Record<string, { source: string; category: string }>>({});
  const autoFixAttempted = useRef(false);

  // Add Videos panel state
  const [addPanelOpen, setAddPanelOpen] = useState(true);
  const [addUrlInput, setAddUrlInput] = useState('');
  const [addingUrls, setAddingUrls] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [recentQueue, setRecentQueue] = useState<StrategyVideoQueueItem[]>([]);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollQueue = useCallback(async () => {
    try {
      const items = await getQueue({ limit: 10, order: 'desc' });
      setRecentQueue(items);
      // Stop polling when nothing is in-flight
      const hasActive = items.some(i => i.status === 'pending' || i.status === 'processing');
      if (!hasActive && pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
        if (onRefresh) onRefresh();
      }
    } catch { /* ignore */ }
  }, [onRefresh]);

  const startPolling = useCallback(() => {
    if (pollingRef.current) return;
    pollingRef.current = setInterval(pollQueue, 4000);
    void pollQueue();
  }, [pollQueue]);

  useEffect(() => () => { if (pollingRef.current) clearInterval(pollingRef.current); }, []);

  const handleAddUrls = async () => {
    const raw = addUrlInput.trim();
    if (!raw) return;
    const urls = raw.split(/[\n,]+/).map(u => u.trim()).filter(Boolean);
    if (urls.length === 0) return;
    setAddingUrls(true);
    setAddError(null);
    try {
      await addUrlsToQueue(urls);
      await processQueue();
      setAddUrlInput('');
      startPolling();
    } catch (e) {
      setAddError((e as Error).message ?? 'Failed to add URLs');
    } finally {
      setAddingUrls(false);
    }
  };

  const handleFetchCaptions = async (videoId: string) => {
    if (!onRefresh) return;
    setFetchingCaptionsVideoId(videoId);
    try {
      await fetchYouTubeTranscript({ video_id: videoId });
      startPolling();
    } finally {
      setFetchingCaptionsVideoId(null);
    }
  };

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
        platform: status?.platform ?? null,
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
        transcript: status?.transcript ?? null,
        ingestStatus: status?.ingestStatus ?? null,
        ingestError: status?.ingestError ?? null,
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
        videoHeading: status.videoHeading ?? 'Untitled video',
        platform: status.platform ?? null,
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
        transcript: status.transcript ?? null,
        ingestStatus: status.ingestStatus ?? null,
        ingestError: status.ingestError ?? null,
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

  const assignOptions = useMemo(() => {
    return sourceNames
      .filter((s) => s !== 'Unknown')
      .map((sourceName) => {
        const perf = sourcePerfByName.get(sourceName);
        const rows = rowsBySource.get(sourceName) ?? [];
        const url = perf?.sourceUrl ?? rows[0]?.sourceUrl;
        const handle = url ? (url.match(/instagram\.com\/([^/]+)/i)?.[1] ?? null) : null;
        return { sourceName, sourceHandle: handle ?? sourceName.toLowerCase().replace(/\s+/g, '') };
      })
      .filter((o) => o.sourceHandle);
  }, [sourceNames, sourcePerfByName, rowsBySource]);

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

  const handleAssignVideo = async (videoId: string, baseKey: string) => {
    const sel = videoAssignSelections[baseKey];
    if (!sel?.source || !onRefresh) return;
    const opt = assignOptions.find((o) => o.sourceName === sel.source);
    if (!opt) return;
    setAssigningVideoId(videoId);
    try {
      const { assigned } = await assignUnknownToSource({
        source_handle: opt.sourceHandle,
        source_name: opt.sourceName,
        video_ids: [videoId],
        strategy_type: sel.category ? (sel.category as 'daily_signal' | 'generic_strategy') : undefined,
      });
      if (assigned > 0) onRefresh();
    } finally {
      setAssigningVideoId(null);
    }
  };

  const handleCategoryChange = async (videoId: string, strategyType: 'daily_signal' | 'generic_strategy') => {
    if (!onRefresh) return;
    setUpdatingCategoryVideoId(videoId);
    try {
      await updateStrategyVideoMetadata({ video_id: videoId, strategy_type: strategyType });
      onRefresh();
    } finally {
      setUpdatingCategoryVideoId(null);
    }
  };

  const handlePasteTranscript = async (videoId: string) => {
    const text = pasteTranscriptText.trim();
    if (!text || !onRefresh) return;
    setExtractingVideoId(videoId);
    try {
      await extractFromTranscript({ video_id: videoId, transcript: text });
      setPasteTranscriptVideoId(null);
      setPasteTranscriptText('');
      onRefresh();
    } finally {
      setExtractingVideoId(null);
    }
  };

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

  const videoUrlFor = (videoId: string, platform: StrategyRow['platform']) => {
    if (platform === 'youtube') return `https://www.youtube.com/watch?v=${videoId}`;
    if (platform === 'twitter') return `https://twitter.com/i/status/${videoId}`;
    return `https://www.instagram.com/reel/${videoId}/`;
  };

  return (
    <div className="space-y-3">
      {/* Add Videos Panel */}
      <div className="rounded-xl border-2 border-blue-200 bg-blue-50 overflow-hidden">
        <button
          onClick={() => setAddPanelOpen(v => !v)}
          className="w-full px-4 py-3 flex items-center justify-between gap-3 hover:bg-blue-100/60 transition-colors"
        >
          <span className="flex items-center gap-2.5 text-sm font-bold text-blue-800">
            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-600 text-white">
              <Plus className="w-3.5 h-3.5" />
            </span>
            Add Strategy Videos
            <span className="text-xs font-normal text-blue-600">Instagram · YouTube · Twitter</span>
          </span>
          {addPanelOpen
            ? <ChevronUp className="w-4 h-4 text-blue-500 shrink-0" />
            : <ChevronDown className="w-4 h-4 text-blue-500 shrink-0" />}
        </button>
        {addPanelOpen && (
          <div className="px-4 pb-4 space-y-3 border-t border-blue-200 pt-3 bg-white">
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              Paste one or more URLs (one per line). YouTube captions are fetched automatically. Instagram triggers a background job — if it fails, you can paste the transcript manually.
            </p>
            <textarea
              value={addUrlInput}
              onChange={e => setAddUrlInput(e.target.value)}
              placeholder={"https://www.instagram.com/reel/ABC123/\nhttps://www.youtube.com/watch?v=XYZ"}
              className="w-full min-h-[72px] p-2.5 text-sm border border-blue-200 rounded-lg bg-white resize-y font-mono focus:outline-none focus:ring-2 focus:ring-blue-400"
              rows={3}
            />
            <div className="flex items-center gap-2">
              <button
                onClick={handleAddUrls}
                disabled={addingUrls || !addUrlInput.trim()}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
              >
                {addingUrls ? 'Adding…' : 'Add & Queue'}
              </button>
              {addError && <span className="text-xs text-red-600">{addError}</span>}
            </div>

            {recentQueue.length > 0 && (
              <div className="mt-1 space-y-1.5">
                <p className="text-xs font-semibold text-[hsl(var(--muted-foreground))]">Recent queue</p>
                {recentQueue.map(item => (
                  <div key={item.id} className="flex items-center gap-2 text-xs">
                    <span className={cn(
                      'inline-flex px-1.5 py-0.5 rounded font-medium text-[10px] shrink-0',
                      item.status === 'done' && 'bg-emerald-100 text-emerald-700',
                      item.status === 'processing' && 'bg-blue-100 text-blue-700',
                      item.status === 'pending' && 'bg-amber-100 text-amber-700',
                      item.status === 'failed' && 'bg-red-100 text-red-700',
                    )}>
                      {item.status === 'processing' ? 'processing…' : item.status}
                    </span>
                    <Link2 className="w-3 h-3 text-[hsl(var(--muted-foreground))] shrink-0" />
                    <a href={item.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline truncate max-w-[300px]">{item.url}</a>
                    {item.error_message && <span className="text-red-600 truncate max-w-[180px]" title={item.error_message}>{item.error_message}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

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
              <button
                onClick={async () => {
                  setCleaning(true);
                  try {
                    const { processed } = await cleanupStrategyAssignments();
                    if (processed > 0 && onRefresh) onRefresh();
                  } finally {
                    setCleaning(false);
                  }
                }}
                disabled={cleaning}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium whitespace-nowrap disabled:opacity-50"
                title="Remove assigned videos from Unknown (fix duplicates)"
              >
                {cleaning ? 'Cleaning…' : 'Cleanup duplicates'}
              </button>
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
                                              <a href={videoUrlFor(video.videoId, video.platform)} target="_blank" rel="noreferrer" className="text-blue-600 hover:text-blue-700">Open {video.platform ?? 'video'}</a>
                                            </div>
                                          )}
                                          {(video.strategyType || video.applicableDate) && (
                                            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-[hsl(var(--muted-foreground))]">
                                              {video.strategyType === 'daily_signal' && video.applicableDate && (
                                                <span>Applicable: {video.applicableDate}</span>
                                              )}
                                              {video.strategyType === 'generic_strategy' && video.applicableTimeframes && video.applicableTimeframes.length > 0 && (
                                                <span>Scope: {video.applicableTimeframes.includes('DAY_TRADE') && video.applicableTimeframes.includes('SWING_TRADE') ? 'day + swing' : video.applicableTimeframes.includes('DAY_TRADE') ? 'day trade' : 'swing'}</span>
                                              )}
                                            </div>
                                          )}
                                          {/* 3-step ingest pipeline */}
                                          {video.videoId && (
                                            <div className="mt-2 space-y-1">
                                              {/* Step 1: Source */}
                                              <div className="flex items-center gap-1.5 text-[10px]">
                                                <span className={cn(
                                                  'w-4 h-4 rounded-full flex items-center justify-center text-white font-bold text-[9px] shrink-0',
                                                  sourceName !== 'Unknown' ? 'bg-emerald-500' : 'bg-amber-400'
                                                )}>1</span>
                                                <span className="text-[hsl(var(--muted-foreground))]">Source:</span>
                                                <span className={sourceName !== 'Unknown' ? 'text-emerald-600 font-medium' : 'text-amber-600 font-medium'}>
                                                  {sourceName !== 'Unknown' ? sourceName : 'Unknown — needs assignment'}
                                                </span>
                                              </div>
                                              {/* Step 2: Transcript */}
                                              <div className="flex items-start gap-1.5 text-[10px]">
                                                <span className={cn(
                                                  'w-4 h-4 rounded-full flex items-center justify-center text-white font-bold text-[9px] shrink-0 mt-0.5',
                                                  video.ingestStatus === 'done' ? 'bg-emerald-500'
                                                    : video.ingestStatus === 'transcribing' ? 'bg-blue-500'
                                                    : video.ingestStatus === 'failed' ? 'bg-red-500'
                                                    : 'bg-amber-400'
                                                )}>2</span>
                                                <div className="flex-1 min-w-0">
                                                  <div className="flex items-center gap-1.5 flex-wrap">
                                                    <span className="text-[hsl(var(--muted-foreground))]">Transcript:</span>
                                                    <span className={cn(
                                                      'font-medium',
                                                      video.ingestStatus === 'done' ? 'text-emerald-600'
                                                        : video.ingestStatus === 'transcribing' ? 'text-blue-600'
                                                        : video.ingestStatus === 'failed' ? 'text-red-600'
                                                        : 'text-amber-600'
                                                    )}>
                                                      {video.ingestStatus === 'done' ? 'Transcribed' : video.ingestStatus === 'transcribing' ? 'Transcribing…' : video.ingestStatus === 'failed' ? 'Failed' : 'Pending'}
                                                    </span>
                                                    {video.ingestStatus !== 'done' && video.ingestStatus !== 'transcribing' && (
                                                      video.platform === 'youtube' ? (
                                                        <button
                                                          onClick={() => handleFetchCaptions(video.videoId!)}
                                                          disabled={fetchingCaptionsVideoId === video.videoId}
                                                          className="px-1.5 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                                                        >
                                                          {fetchingCaptionsVideoId === video.videoId ? 'Fetching…' : 'Fetch captions'}
                                                        </button>
                                                      ) : (
                                                        <button
                                                          type="button"
                                                          onClick={() => { setPasteTranscriptVideoId(video.videoId); setPasteTranscriptText(''); }}
                                                          className="text-blue-600 hover:text-blue-700 font-medium"
                                                        >
                                                          {video.platform === 'instagram' ? 'Instagram: paste transcript' : 'Paste transcript'}
                                                        </button>
                                                      )
                                                    )}
                                                  </div>
                                                  {video.ingestError && (
                                                    <p className="text-red-600 truncate max-w-[240px] mt-0.5" title={video.ingestError}>{video.ingestError}</p>
                                                  )}
                                                  {video.transcript && (
                                                    <button
                                                      type="button"
                                                      onClick={() => setExpandedTranscript(expandedTranscript === baseKey ? null : baseKey)}
                                                      className="text-blue-600 hover:text-blue-700 font-medium mt-0.5"
                                                    >
                                                      {expandedTranscript === baseKey ? 'Hide transcript' : 'Show transcript'}
                                                    </button>
                                                  )}
                                                  {expandedTranscript === baseKey && video.transcript && (
                                                    <pre className="mt-1 p-2 bg-[hsl(var(--muted))]/30 rounded text-[10px] whitespace-pre-wrap max-h-40 overflow-y-auto font-sans">
                                                      {video.transcript}
                                                    </pre>
                                                  )}
                                                  {/* Paste transcript inline form */}
                                                  {pasteTranscriptVideoId === video.videoId && (
                                                    <div className="mt-2 space-y-1.5">
                                                      <textarea
                                                        value={pasteTranscriptText}
                                                        onChange={(e) => setPasteTranscriptText(e.target.value)}
                                                        placeholder="Paste transcript here…"
                                                        className="w-full min-h-[80px] p-2 text-xs border rounded bg-white resize-y"
                                                        rows={4}
                                                      />
                                                      <div className="flex items-center gap-2">
                                                        <button
                                                          onClick={() => handlePasteTranscript(video.videoId!)}
                                                          disabled={!pasteTranscriptText.trim() || extractingVideoId === video.videoId}
                                                          className="text-xs px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                                                        >
                                                          {extractingVideoId === video.videoId ? 'Extracting…' : 'Extract metadata'}
                                                        </button>
                                                        <button
                                                          onClick={() => { setPasteTranscriptVideoId(null); setPasteTranscriptText(''); }}
                                                          className="text-xs px-2 py-1 rounded border hover:bg-[hsl(var(--secondary))]"
                                                        >
                                                          Cancel
                                                        </button>
                                                      </div>
                                                    </div>
                                                  )}
                                                </div>
                                              </div>
                                              {/* Step 3: Metadata extraction */}
                                              <div className="flex items-center gap-1.5 text-[10px]">
                                                <span className={cn(
                                                  'w-4 h-4 rounded-full flex items-center justify-center text-white font-bold text-[9px] shrink-0',
                                                  video.ingestStatus === 'done' && video.strategyType ? 'bg-emerald-500'
                                                    : video.ingestStatus === 'done' ? 'bg-amber-400'
                                                    : 'bg-gray-300'
                                                )}>3</span>
                                                <span className="text-[hsl(var(--muted-foreground))]">Metadata:</span>
                                                {video.ingestStatus === 'done' && video.strategyType ? (
                                                  <span className="text-emerald-600 font-medium">Extracted ({video.strategyType === 'daily_signal' ? 'daily' : 'generic'})</span>
                                                ) : video.ingestStatus === 'done' ? (
                                                  <div className="flex items-center gap-1.5">
                                                    <span className="text-amber-600 font-medium">Not extracted</span>
                                                    <button
                                                      type="button"
                                                      onClick={() => { setPasteTranscriptVideoId(video.videoId); setPasteTranscriptText(video.transcript ?? ''); }}
                                                      className="text-blue-600 hover:text-blue-700 font-medium"
                                                    >
                                                      Re-extract
                                                    </button>
                                                  </div>
                                                ) : (
                                                  <span className="text-gray-400">Waiting for transcript</span>
                                                )}
                                              </div>
                                            </div>
                                          )}
                                          {sourceName === 'Unknown' && video.videoId && assignOptions.length > 0 && (
                                            <div className="mt-2 flex flex-wrap items-center gap-2">
                                              <span className="text-[10px] text-[hsl(var(--muted-foreground))]">Assign to:</span>
                                              <select
                                                value={videoAssignSelections[baseKey]?.source ?? ''}
                                                onChange={(e) => setVideoAssignSelections(prev => ({ ...prev, [baseKey]: { ...prev[baseKey], source: e.target.value, category: prev[baseKey]?.category ?? 'generic_strategy' } }))}
                                                className="text-xs border rounded px-2 py-1 bg-white min-w-[140px]"
                                              >
                                                <option value="">Select source…</option>
                                                {assignOptions.map((o) => (
                                                  <option key={o.sourceHandle} value={o.sourceName}>{o.sourceName}</option>
                                                ))}
                                              </select>
                                              <span className="text-[10px] text-[hsl(var(--muted-foreground))]">Category:</span>
                                              <select
                                                value={videoAssignSelections[baseKey]?.category ?? 'generic_strategy'}
                                                onChange={(e) => setVideoAssignSelections(prev => ({ ...prev, [baseKey]: { ...prev[baseKey], category: e.target.value, source: prev[baseKey]?.source ?? '' } }))}
                                                className="text-xs border rounded px-2 py-1 bg-white"
                                              >
                                                <option value="daily_signal">Daily signal</option>
                                                <option value="generic_strategy">Generic strategy</option>
                                              </select>
                                              <button
                                                onClick={() => handleAssignVideo(video.videoId!, baseKey)}
                                                disabled={!videoAssignSelections[baseKey]?.source || assigningVideoId === video.videoId}
                                                className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                              >
                                                {assigningVideoId === video.videoId ? 'Assigning…' : 'Assign'}
                                              </button>
                                            </div>
                                          )}
                                          {sourceName !== 'Unknown' && video.videoId && (
                                            <div className="mt-2 flex items-center gap-2">
                                              <span className="text-[10px] text-[hsl(var(--muted-foreground))]">Category:</span>
                                              <select
                                                value={video.strategyType ?? 'generic_strategy'}
                                                onChange={(e) => {
                                                  const v = e.target.value as 'daily_signal' | 'generic_strategy';
                                                  if (v) handleCategoryChange(video.videoId!, v);
                                                }}
                                                disabled={updatingCategoryVideoId === video.videoId}
                                                className="text-xs border rounded px-2 py-1 bg-white"
                                              >
                                                <option value="daily_signal">Daily signal</option>
                                                <option value="generic_strategy">Generic strategy</option>
                                              </select>
                                              {updatingCategoryVideoId === video.videoId && (
                                                <span className="text-[10px] text-[hsl(var(--muted-foreground))]">Updating…</span>
                                              )}
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
