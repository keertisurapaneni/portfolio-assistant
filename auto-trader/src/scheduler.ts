/**
 * Server-side auto-trade scheduler.
 *
 * Replaces the browser-based useAutoTradeScheduler hook — trades now
 * happen as long as the auto-trader service is running (no browser needed).
 *
 * Schedule: every 15 minutes, 9:00 AM – 4:30 PM ET, weekdays.
 * Realtime: when trade_scans is updated (scanner refresh), executes immediately.
 * On each tick: sync positions, scan for ideas, manage existing positions,
 * execute qualifying trades via IB Gateway.
 */

import cron from 'node-cron';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isConnected,
  requestPositions,
  searchContract,
  placeBracketOrder,
  placeMarketOrder,
  type PositionData,
} from './ib-connection.js';
import {
  isConfigured,
  getSupabase,
  getSupabaseUrl,
  getSupabaseAnonKey,
  loadConfig,
  saveConfigPartial,
  getActiveTrades,
  hasActiveTrade,
  countActivePositions,
  createPaperTrade,
  updatePaperTrade,
  createAutoTradeEvent,
  getRecentDipBuyEvents,
  getPastTrimEvents,
  getPastLossCutEvents,
  getRecentClosedStrategyOutcomes,
  createExternalStrategySignal,
  findExternalStrategySignal,
  getDueExternalStrategySignals,
  updateExternalStrategySignal,
  savePortfolioSnapshot,
  getPerformance,
  type AutoTraderConfig,
  type ExternalStrategySignal,
  type PaperTrade,
} from './lib/supabase.js';

// ── Types ────────────────────────────────────────────────

interface TradeIdea {
  ticker: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  signal: 'BUY' | 'SELL';
  confidence: number;
  reason: string;
  tags: string[];
  mode: 'DAY_TRADE' | 'SWING_TRADE';
}

interface TradingSignalsResponse {
  trade: {
    recommendation: 'BUY' | 'SELL' | 'HOLD';
    confidence: number;
    entryPrice: number | null;
    stopLoss: number | null;
    targetPrice: number | null;
    targetPrice2: number | null;
    riskReward: string | null;
    rationale: { technical?: string; sentiment?: string; risk?: string };
  };
}

interface EnrichedPosition {
  symbol: string;
  position: number;
  avgCost: number;
  conId: number;
  mktPrice: number;
  mktValue: number;
  unrealizedPnl: number;
}

interface SuggestedStock {
  ticker: string;
  conviction: number;
  valuationTag: string;
  tag: string;
  reason: string;
}

interface DailyVideoSignal {
  ticker: string;
  longTriggerAbove?: number;
  longTargets?: number[];
  shortTriggerBelow?: number;
  shortTargets?: number[];
}

interface StrategyVideoRecord {
  videoId: string;
  sourceHandle?: string;
  sourceName?: string;
  reelUrl?: string;
  canonicalUrl?: string;
  videoHeading?: string;
  strategyType?: 'daily_signal' | 'generic_strategy';
  timeframe?: 'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM';
  applicableTimeframes?: Array<'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM'>;
  executionWindowEt?: {
    start?: string;
    end?: string;
  };
  tradeDate?: string;
  extractedSignals?: DailyVideoSignal[];
}

// ── State ────────────────────────────────────────────────

let _cronJob: cron.ScheduledTask | null = null;
let _firstCandleCronJob: cron.ScheduledTask | null = null;
let _realtimeChannel: { unsubscribe: () => void } | null = null;
let _realtimeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const REALTIME_DEBOUNCE_MS = 3000; // coalesce day_trades + swing_trades writes
let _running = false;
let _lastRun: Date | null = null;
let _lastRunResult: string = 'never';
let _runCount = 0;
let _lastSuggestedFindsDate = '';
let _lastSnapshotDate = '';
let _lastRehydrationDate = '';
let _pendingDeployedDollar = 0;
let _dailyDeployedDollar = 0;
let _dailyDeployedDate = '';
const _processedTickers = new Set<string>();
let _processedTickersDate = '';

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const FINNHUB_KEY = process.env.FINNHUB_API_KEY ?? '';
const __dirname = dirname(fileURLToPath(import.meta.url));
const STRATEGY_VIDEOS_FILES = [
  resolve(__dirname, '../strategy-videos.json'),
  resolve(process.cwd(), 'strategy-videos.json'),
];
const STRATEGY_X_CONSECUTIVE_LOSS_LIMIT = 2;
let _lastDailyVideoQueueLogDate = '';

// ── Public API ───────────────────────────────────────────

export function startScheduler(): void {
  if (_cronJob || _firstCandleCronJob) {
    console.log('[Scheduler] Already running');
    return;
  }

  if (!isConfigured()) {
    console.log('[Scheduler] Supabase not configured — scheduler disabled');
    console.log('[Scheduler] Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY in .env');
    return;
  }

  // Run every 15 minutes between 9:00-16:30 ET on weekdays (faster position management).
  // node-cron uses server-local time, so we use the TZ option.
  _cronJob = cron.schedule('*/15 9-16 * * 1-5', () => {
    runSchedulerCycle().catch(err => {
      console.error('[Scheduler] Cycle failed:', err);
      _lastRunResult = `error: ${err instanceof Error ? err.message : 'unknown'}`;
    });
  }, {
    timezone: 'America/New_York',
  });

  // Extra one-shot daily pass right after opening range finalizes (first-candle setups).
  _firstCandleCronJob = cron.schedule('36 9 * * 1-5', () => {
    runSchedulerCycle().catch(err => {
      console.error('[Scheduler] First-candle cycle failed:', err);
      _lastRunResult = `error: ${err instanceof Error ? err.message : 'unknown'}`;
    });
  }, {
    timezone: 'America/New_York',
  });

  console.log('[Scheduler] Started — every 15 min + 9:36 ET first-candle pass (weekdays)');

  // Realtime: execute trades immediately when scanner refreshes (e.g. from TradeIdeas UI)
  subscribeToTradeScans();

  // Run once on startup (delayed 10s to let IB connect)
  setTimeout(() => {
    runSchedulerCycle().catch(err => {
      console.error('[Scheduler] Initial cycle failed:', err);
    });
  }, 10_000);
}

export function stopScheduler(): void {
  unsubscribeFromTradeScans();
  if (_cronJob) {
    _cronJob.stop();
    _cronJob = null;
  }
  if (_firstCandleCronJob) {
    _firstCandleCronJob.stop();
    _firstCandleCronJob = null;
  }
  if (!_cronJob && !_firstCandleCronJob) {
    console.log('[Scheduler] Stopped');
  }
}

export function isSchedulerRunning(): boolean {
  return !!_cronJob || !!_firstCandleCronJob;
}

export function getSchedulerStatus() {
  return {
    running: !!_cronJob || !!_firstCandleCronJob,
    executing: _running,
    lastRun: _lastRun?.toISOString() ?? null,
    lastResult: _lastRunResult,
    runCount: _runCount,
    ibConnected: isConnected(),
    supabaseConfigured: isConfigured(),
  };
}

/** Trigger a manual run outside the cron schedule */
export async function triggerManualRun(): Promise<string> {
  if (_running) return 'already executing';
  try {
    await runSchedulerCycle();
    return 'completed';
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : 'unknown'}`;
  }
}

// ── Helpers ──────────────────────────────────────────────

function log(msg: string): void {
  console.log(`[Scheduler] ${msg}`);
}

function isMarketHoursET(): boolean {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
}

function isPastMarketCloseET(): boolean {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return et.getHours() * 60 + et.getMinutes() >= 16 * 60 + 15;
}

function getETMinutes(): number {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return et.getHours() * 60 + et.getMinutes();
}

function formatDateToEtIso(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find(p => p.type === 'year')?.value ?? '0000';
  const month = parts.find(p => p.type === 'month')?.value ?? '00';
  const day = parts.find(p => p.type === 'day')?.value ?? '00';
  return `${year}-${month}-${day}`;
}

function getETDateString(): string {
  return formatDateToEtIso(new Date());
}

function resetProcessedTickersIfNewDay(): void {
  const todayET = getETDateString();
  if (_processedTickersDate !== todayET) {
    _processedTickers.clear();
    _processedTickersDate = todayET;
  }
}

function normalizeDateToEtIso(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatDateToEtIso(parsed);
}

function parseEtClockToMinutes(value: string | null | undefined): number | null {
  const raw = (value ?? '').trim();
  const m = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  return h * 60 + min;
}

function inferSourceUrl(video: StrategyVideoRecord): string | null {
  const handle = (video.sourceHandle ?? '').trim().replace(/^@+/, '');
  if (handle) {
    return `https://www.instagram.com/${handle}/`;
  }
  const base = video.canonicalUrl ?? video.reelUrl ?? '';
  const m = base.match(/instagram\.com\/([^/]+)\/reel\//i);
  if (!m?.[1]) return null;
  return `https://www.instagram.com/${m[1]}/`;
}

async function loadStrategyVideos(): Promise<StrategyVideoRecord[]> {
  for (const file of STRATEGY_VIDEOS_FILES) {
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        log(`Strategy videos file is not an array: ${file}`);
        return [];
      }
      return parsed as StrategyVideoRecord[];
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      log(`Failed to load strategy videos (${file}): ${err instanceof Error ? err.message : 'unknown'}`);
      return [];
    }
  }
  log(`Strategy videos file not found. Checked: ${STRATEGY_VIDEOS_FILES.join(', ')}`);
  return [];
}

async function autoQueueDailySignalsFromTrackedVideos(): Promise<void> {
  const todayET = getETDateString();
  const videos = await loadStrategyVideos();
  const dailyVideos = videos.filter(v =>
    v.strategyType === 'daily_signal' &&
    normalizeDateToEtIso(v.tradeDate) === todayET &&
    Array.isArray(v.extractedSignals) &&
    (v.extractedSignals?.length ?? 0) > 0
  );
  if (dailyVideos.length === 0) {
    if (_lastDailyVideoQueueLogDate !== todayET) {
      const knownTradeDates = [...new Set(
        videos.map(v => normalizeDateToEtIso(v.tradeDate)).filter(Boolean) as string[]
      )];
      log(`No daily strategy videos matched ET date ${todayET} (videos:${videos.length}, tradeDates:${knownTradeDates.join(', ') || 'none'})`);
      _lastDailyVideoQueueLogDate = todayET;
    }
    return;
  }

  let created = 0;
  let deduped = 0;

  for (const video of dailyVideos) {
    const sourceName = (video.sourceName ?? '').trim();
    if (!sourceName) continue;
    const sourceUrl = inferSourceUrl(video);
    const heading = (video.videoHeading ?? video.videoId).trim();
    const mode = video.timeframe ?? 'DAY_TRADE';

    for (const setup of (video.extractedSignals ?? [])) {
      const ticker = String(setup.ticker ?? '').trim().toUpperCase();
      if (!ticker) continue;

      if (setup.longTriggerAbove && Array.isArray(setup.longTargets) && setup.longTargets[0]) {
        const exists = await findExternalStrategySignal({
          sourceName,
          ticker,
          signal: 'BUY',
          mode,
          executeOnDate: todayET,
          strategyVideoId: video.videoId,
        });
        if (!exists) {
          await createExternalStrategySignal({
            source_name: sourceName,
            source_url: sourceUrl,
            strategy_video_id: video.videoId,
            strategy_video_heading: heading,
            ticker,
            signal: 'BUY',
            mode,
            confidence: 8,
            entry_price: setup.longTriggerAbove,
            stop_loss: setup.shortTriggerBelow ?? null,
            target_price: setup.longTargets[0],
            execute_on_date: todayET,
            notes: `Auto from video ${video.videoId} | ${heading} | long breakout`,
          });
          created += 1;
        } else {
          deduped += 1;
        }
      }

      if (setup.shortTriggerBelow && Array.isArray(setup.shortTargets) && setup.shortTargets[0]) {
        const exists = await findExternalStrategySignal({
          sourceName,
          ticker,
          signal: 'SELL',
          mode,
          executeOnDate: todayET,
          strategyVideoId: video.videoId,
        });
        if (!exists) {
          await createExternalStrategySignal({
            source_name: sourceName,
            source_url: sourceUrl,
            strategy_video_id: video.videoId,
            strategy_video_heading: heading,
            ticker,
            signal: 'SELL',
            mode,
            confidence: 8,
            entry_price: setup.shortTriggerBelow,
            stop_loss: setup.longTriggerAbove ?? null,
            target_price: setup.shortTargets[0],
            execute_on_date: todayET,
            notes: `Auto from video ${video.videoId} | ${heading} | short breakdown`,
          });
          created += 1;
        } else {
          deduped += 1;
        }
      }
    }
  }

  if (created > 0) {
    log(`Auto-queued ${created} daily strategy signals from tracked videos`);
  } else if (deduped > 0) {
    log(`Daily strategy signals already queued (${deduped} duplicates skipped)`);
  }
}

async function autoQueueGenericSignalsFromTrackedVideos(
  ideas: TradeIdea[],
  config: AutoTraderConfig,
): Promise<Set<string>> {
  const queuedTickers = new Set<string>();
  if (ideas.length === 0) return queuedTickers;

  const todayET = getETDateString();
  const videos = await loadStrategyVideos();
  const genericVideos = videos.filter(v => v.strategyType === 'generic_strategy');
  if (genericVideos.length === 0) return queuedTickers;

  type GenericStrategyBucket = {
    videoId: string;
    sourceName: string;
    sourceUrl: string | null;
    heading: string;
    timeframe: 'DAY_TRADE' | 'SWING_TRADE';
  };

  const bucketsByTimeframe = new Map<'DAY_TRADE' | 'SWING_TRADE', GenericStrategyBucket[]>();
  for (const video of genericVideos) {
    const sourceName = (video.sourceName ?? '').trim();
    if (!sourceName) continue;
    const sourceUrl = inferSourceUrl(video);
    const heading = (video.videoHeading ?? video.videoId).trim();

    const timeframesRaw = video.applicableTimeframes?.length
      ? video.applicableTimeframes
      : (video.timeframe ? [video.timeframe] : ['DAY_TRADE']);
    const timeframes = timeframesRaw.filter(
      tf => tf === 'DAY_TRADE' || tf === 'SWING_TRADE'
    ) as Array<'DAY_TRADE' | 'SWING_TRADE'>;
    if (timeframes.length === 0) continue;

    for (const timeframe of timeframes) {
      const list = bucketsByTimeframe.get(timeframe) ?? [];
      list.push({
        videoId: video.videoId,
        sourceName,
        sourceUrl,
        heading,
        timeframe,
      });
      bucketsByTimeframe.set(timeframe, list);
    }
  }

  let created = 0;
  let deduped = 0;

  // Cache active-check by ticker to avoid repeated DB roundtrips during allocation.
  const activeTickerCache = new Map<string, boolean>();
  const isActiveTicker = async (ticker: string): Promise<boolean> => {
    const cached = activeTickerCache.get(ticker);
    if (cached != null) return cached;
    const active = await hasActiveTrade(ticker);
    activeTickerCache.set(ticker, active);
    return active;
  };

  for (const [timeframe, buckets] of bucketsByTimeframe.entries()) {
    if (buckets.length === 0) continue;
    const candidates = ideas
      .filter(i => i.mode === timeframe && i.confidence >= config.minScannerConfidence)
      .sort((a, b) => b.confidence - a.confidence);
    if (candidates.length === 0) continue;

    const seenTickers = new Set<string>();
    for (const candidate of candidates) {
      const ticker = candidate.ticker.trim().toUpperCase();
      if (!ticker) continue;
      if (seenTickers.has(ticker)) continue;
      seenTickers.add(ticker);
      if (await isActiveTicker(ticker)) continue;

      let createdForTicker = false;
      let existingForTicker = false;
      for (const bucket of buckets) {
        const exists = await findExternalStrategySignal({
          sourceName: bucket.sourceName,
          ticker,
          signal: candidate.signal,
          mode: timeframe,
          executeOnDate: todayET,
          strategyVideoId: bucket.videoId,
        });
        if (exists) {
          deduped += 1;
          existingForTicker = true;
          continue;
        }

        await createExternalStrategySignal({
          source_name: bucket.sourceName,
          source_url: bucket.sourceUrl,
          strategy_video_id: bucket.videoId,
          strategy_video_heading: bucket.heading,
          ticker,
          signal: candidate.signal,
          mode: timeframe,
          confidence: Math.max(1, Math.min(10, Math.round(candidate.confidence))),
          entry_price: null,
          stop_loss: null,
          target_price: null,
          execute_on_date: todayET,
          notes: `Generic strategy auto from video ${bucket.videoId} | ${bucket.heading} | scanner candidate: ${candidate.reason} | allocation group: ${buckets.length}`,
        });

        created += 1;
        createdForTicker = true;
      }

      if (createdForTicker || existingForTicker) {
        queuedTickers.add(ticker);
      }
    }
  }

  if (created > 0) {
    log(`Auto-queued ${created} generic strategy signals from tracked videos`);
  } else if (deduped > 0) {
    log(`Generic strategy signals already queued (${deduped} duplicates skipped)`);
  }

  return queuedTickers;
}

function isGenericStrategySignal(
  signal: ExternalStrategySignal,
  genericVideoIds: Set<string>,
): boolean {
  const videoId = (signal.strategy_video_id ?? '').trim();
  if (videoId && genericVideoIds.has(videoId)) return true;
  const notes = (signal.notes ?? '').toLowerCase();
  return notes.includes('generic strategy auto');
}

function countConsecutiveLosses(outcomes: Array<{ pnl: number | null }>): number {
  let losses = 0;
  for (const outcome of outcomes) {
    const pnl = outcome.pnl ?? 0;
    if (pnl < 0) {
      losses += 1;
      continue;
    }
    break;
  }
  return losses;
}

async function shouldMarkStrategyX(signal: ExternalStrategySignal): Promise<{
  blocked: boolean;
  scope: 'video' | 'source' | null;
  consecutiveLosses: number;
}> {
  const sourceName = (signal.source_name ?? '').trim();
  if (!sourceName) {
    return { blocked: false, scope: null, consecutiveLosses: 0 };
  }

  if (signal.strategy_video_id) {
    const videoOutcomes = await getRecentClosedStrategyOutcomes({
      sourceName,
      mode: signal.mode,
      strategyVideoId: signal.strategy_video_id,
      limit: 10,
    });
    const videoLosses = countConsecutiveLosses(videoOutcomes);
    if (videoLosses >= STRATEGY_X_CONSECUTIVE_LOSS_LIMIT) {
      return { blocked: true, scope: 'video', consecutiveLosses: videoLosses };
    }
  }

  const sourceOutcomes = await getRecentClosedStrategyOutcomes({
    sourceName,
    mode: signal.mode,
    limit: 10,
  });
  const sourceLosses = countConsecutiveLosses(sourceOutcomes);
  if (sourceLosses >= STRATEGY_X_CONSECUTIVE_LOSS_LIMIT) {
    return { blocked: true, scope: 'source', consecutiveLosses: sourceLosses };
  }

  return { blocked: false, scope: null, consecutiveLosses: sourceLosses };
}

async function getQuotePrice(symbol: string): Promise<number | null> {
  if (!FINNHUB_KEY) return null;
  try {
    const res = await fetch(
      `${FINNHUB_BASE}/quote?symbol=${symbol.toUpperCase()}&token=${FINNHUB_KEY}`
    );
    if (!res.ok) return null;
    const data = await res.json() as { c?: number };
    return data.c && data.c > 0 ? data.c : null;
  } catch { return null; }
}

async function getEnrichedPositions(): Promise<EnrichedPosition[]> {
  const positions = await requestPositions();
  const open = positions.filter(p => p.position !== 0);

  const prices = await Promise.all(
    open.map(p => getQuotePrice(p.symbol))
  );

  return open.map((p, i) => {
    const mktPrice = prices[i] ?? 0;
    const abs = Math.abs(p.position);
    const mktValue = abs * mktPrice;
    const costBasis = abs * p.avgCost;
    const unrealizedPnl = p.position > 0
      ? mktValue - costBasis
      : costBasis - mktValue;
    return {
      symbol: p.symbol,
      position: p.position,
      avgCost: p.avgCost,
      conId: p.conId,
      mktPrice,
      mktValue,
      unrealizedPnl: mktPrice > 0 ? unrealizedPnl : 0,
    };
  });
}

function persistEvent(
  ticker: string,
  eventType: string,
  message: string,
  extra?: Record<string, unknown>
): void {
  createAutoTradeEvent({ ticker, event_type: eventType, message, ...extra });
}

// ── Edge Function Calls ──────────────────────────────────

async function callEdgeFunction<T>(
  name: string,
  body?: Record<string, unknown>
): Promise<T> {
  const url = `${getSupabaseUrl()}/functions/v1/${name}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getSupabaseAnonKey()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `Edge function ${name} failed: ${res.status}`);
  return data as T;
}

async function fetchTradeIdeas(): Promise<{ dayTrades: TradeIdea[]; swingTrades: TradeIdea[] }> {
  return callEdgeFunction('trade-scanner', { portfolioTickers: [] });
}

async function fetchTradingSignal(
  ticker: string,
  mode: string
): Promise<TradingSignalsResponse> {
  return callEdgeFunction('trading-signals', {
    ticker: ticker.trim().toUpperCase(),
    mode,
  });
}

async function fetchDailySuggestions(): Promise<SuggestedStock[] | null> {
  try {
    const url = `${getSupabaseUrl()}/functions/v1/daily-suggestions`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${getSupabaseAnonKey()}` },
    });
    const data = await res.json() as {
      cached: boolean;
      data?: { compounders?: SuggestedStock[]; goldMines?: SuggestedStock[] };
    };
    if (!data.cached || !data.data) return null;
    return [
      ...(data.data.compounders ?? []),
      ...(data.data.goldMines ?? []),
    ];
  } catch { return null; }
}

// ── Position Sizing ──────────────────────────────────────

function convictionMultiplier(conv: number): number {
  if (conv >= 10) return 1.5;
  if (conv >= 9) return 1.25;
  if (conv >= 8) return 1.0;
  if (conv >= 7) return 0.75;
  return 0.5;
}

function calculatePositionSize(
  config: AutoTraderConfig,
  params: {
    price: number;
    mode: 'LONG_TERM' | 'DAY_TRADE' | 'SWING_TRADE';
    conviction?: number;
    entryPrice?: number;
    stopLoss?: number;
    regimeMultiplier?: number;
    drawdownMultiplier?: number;
  }
): { quantity: number; dollarSize: number } {
  const {
    price, mode, conviction, entryPrice, stopLoss,
    regimeMultiplier = 1.0, drawdownMultiplier = 1.0,
  } = params;
  const alloc = config.maxTotalAllocation;
  const hardMaxDollar = alloc * 0.10;

  if (!config.useDynamicSizing || price <= 0) {
    const cappedSize = Math.min(config.positionSize, hardMaxDollar);
    const qty = Math.max(1, Math.floor(cappedSize / price));
    return { quantity: qty, dollarSize: qty * price };
  }

  const pv = config.portfolioValue;
  const maxDollar = Math.min(pv * (config.maxPositionPct / 100), hardMaxDollar);
  let dollarSize: number;

  if (mode === 'LONG_TERM' && conviction != null) {
    const base = alloc * (config.baseAllocationPct / 100);
    dollarSize = base * convictionMultiplier(conviction);
  } else if (stopLoss && entryPrice && Math.abs(entryPrice - stopLoss) > 0) {
    const riskBudget = alloc * (config.riskPerTradePct / 100);
    const riskPerShare = Math.abs(entryPrice - stopLoss);
    const qty = Math.floor(riskBudget / riskPerShare);
    dollarSize = qty * price;
  } else {
    dollarSize = config.positionSize;
  }

  dollarSize = dollarSize * regimeMultiplier * drawdownMultiplier;
  dollarSize = Math.min(dollarSize, maxDollar);
  dollarSize = Math.max(dollarSize, 100);
  const quantity = Math.max(1, Math.floor(dollarSize / price));
  return { quantity, dollarSize: quantity * price };
}

// ── Allocation / Daily Limit Checks ──────────────────────

function recordPendingOrder(dollarSize: number): void {
  _pendingDeployedDollar += dollarSize;
  const today = new Date().toISOString().slice(0, 10);
  if (_dailyDeployedDate !== today) {
    _dailyDeployedDollar = 0;
    _dailyDeployedDate = today;
  }
  _dailyDeployedDollar += dollarSize;
}

async function getTotalDeployed(positions: EnrichedPosition[]): Promise<number> {
  if (positions.length > 0) {
    const ibDeployed = positions.reduce(
      (sum, p) => sum + Math.abs(p.position) * p.avgCost, 0
    );
    return ibDeployed + _pendingDeployedDollar;
  }
  const trades = await getActiveTrades();
  return trades.reduce((sum, t) => sum + (t.position_size ?? 0), 0) + _pendingDeployedDollar;
}

async function checkAllocationCap(
  config: AutoTraderConfig,
  positionSize: number,
  ticker: string,
  positions: EnrichedPosition[],
): Promise<boolean> {
  const deployed = await getTotalDeployed(positions);
  const cap = config.maxTotalAllocation;

  if (deployed >= cap * 0.95) {
    log(`CIRCUIT BREAKER: ${ticker} — already at $${deployed.toFixed(0)} of $${cap} cap`);
    persistEvent(ticker, 'warning', 'Circuit breaker: at cap limit', {
      action: 'skipped', source: 'system',
      skip_reason: 'Circuit breaker: at cap limit',
    });
    return false;
  }
  if (deployed + positionSize > cap) {
    log(`Allocation cap hit for ${ticker}: $${deployed.toFixed(0)} + $${positionSize.toFixed(0)} > $${cap}`);
    return false;
  }

  const today = new Date().toISOString().slice(0, 10);
  if (_dailyDeployedDate !== today) { _dailyDeployedDollar = 0; _dailyDeployedDate = today; }
  if (_dailyDeployedDollar + positionSize > config.maxDailyDeployment) {
    log(`Daily limit for ${ticker}: $${_dailyDeployedDollar.toFixed(0)} + $${positionSize.toFixed(0)} > $${config.maxDailyDeployment}/day`);
    return false;
  }
  return true;
}

// ── Portfolio Health / Drawdown ──────────────────────────

function assessDrawdownMultiplier(positions: EnrichedPosition[]): {
  multiplier: number;
  level: string;
  pnlPct: number;
} {
  if (positions.length === 0) return { multiplier: 1.0, level: 'normal', pnlPct: 0 };

  let totalPnl = 0;
  let totalCost = 0;
  for (const pos of positions) {
    if (pos.mktPrice <= 0 || pos.avgCost <= 0) continue;
    totalCost += Math.abs(pos.position) * pos.avgCost;
    totalPnl += pos.unrealizedPnl;
  }

  const pnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
  if (pnlPct <= -5) return { multiplier: 0, level: 'critical', pnlPct };
  if (pnlPct <= -3) return { multiplier: 0.5, level: 'defensive', pnlPct };
  if (pnlPct <= -1) return { multiplier: 0.75, level: 'caution', pnlPct };
  return { multiplier: 1.0, level: 'normal', pnlPct };
}

// ── Sector / Earnings Checks ─────────────────────────────

const _sectorCache = new Map<string, string>();

async function getTickerSector(ticker: string): Promise<string | null> {
  const cached = _sectorCache.get(ticker.toUpperCase());
  if (cached) return cached;
  if (!FINNHUB_KEY) return null;
  try {
    const res = await fetch(
      `${FINNHUB_BASE}/stock/profile2?symbol=${ticker.toUpperCase()}&token=${FINNHUB_KEY}`
    );
    if (!res.ok) return null;
    const data = await res.json() as { finnhubIndustry?: string };
    if (data.finnhubIndustry) {
      _sectorCache.set(ticker.toUpperCase(), data.finnhubIndustry);
      return data.finnhubIndustry;
    }
    return null;
  } catch { return null; }
}

async function checkSectorExposure(
  config: AutoTraderConfig,
  ticker: string,
  positionSize: number,
): Promise<boolean> {
  if (config.maxSectorPct >= 100) return true;
  const sector = await getTickerSector(ticker);
  if (!sector) return true;
  const trades = await getActiveTrades();
  let sectorExposure = 0;
  for (const t of trades) {
    const s = await getTickerSector(t.ticker);
    if (s === sector) sectorExposure += t.position_size ?? 0;
  }
  const maxSectorDollar = config.portfolioValue * (config.maxSectorPct / 100);
  if (sectorExposure + positionSize > maxSectorDollar) {
    log(`Sector limit: ${ticker} (${sector}) — $${sectorExposure.toFixed(0)} + $${positionSize.toFixed(0)} > $${maxSectorDollar.toFixed(0)}`);
    return false;
  }
  return true;
}

async function checkEarningsBlackout(
  config: AutoTraderConfig,
  ticker: string,
): Promise<boolean> {
  if (!config.earningsAvoidEnabled || !FINNHUB_KEY) return true;
  try {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const res = await fetch(
      `${FINNHUB_BASE}/calendar/earnings?symbol=${ticker.toUpperCase()}&from=${from}&to=${to}&token=${FINNHUB_KEY}`
    );
    if (!res.ok) return true;
    const data = await res.json() as {
      earningsCalendar?: { date?: string; symbol?: string }[];
    };
    const next = data.earningsCalendar?.find(e => e.symbol === ticker.toUpperCase());
    if (next?.date) {
      const daysUntil = (new Date(next.date).getTime() - Date.now()) / 86400000;
      if (daysUntil >= 0 && daysUntil <= config.earningsBlackoutDays) {
        log(`Earnings blackout: ${ticker} has earnings in ${daysUntil.toFixed(0)} days`);
        return false;
      }
    }
    return true;
  } catch { return true; }
}

async function runPreTradeChecks(
  config: AutoTraderConfig,
  ticker: string,
  positionSize: number,
  positions: EnrichedPosition[],
): Promise<boolean> {
  const dd = assessDrawdownMultiplier(positions);
  if (dd.level === 'critical') {
    log(`DRAWDOWN PROTECTION: portfolio at ${dd.pnlPct.toFixed(1)}% — blocking new entries`);
    return false;
  }
  if (!(await checkAllocationCap(config, positionSize, ticker, positions))) return false;
  if (!(await checkSectorExposure(config, ticker, positionSize))) return false;
  if (!(await checkEarningsBlackout(config, ticker))) return false;
  return true;
}

// ── Trade Execution ──────────────────────────────────────

async function executeScannerTrade(
  idea: TradeIdea,
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
): Promise<string> {
  const { ticker, signal, confidence: scannerConf, mode } = idea;

  if (await hasActiveTrade(ticker)) return 'skipped:duplicate';

  // Full analysis
  let fa: TradingSignalsResponse;
  try {
    const faMode = mode === 'DAY_TRADE' ? 'DAY_TRADE' : 'SWING_TRADE';
    fa = await fetchTradingSignal(ticker, faMode);
  } catch (err) {
    log(`${ticker}: FA failed — ${err instanceof Error ? err.message : 'unknown'}`);
    return 'failed:fa';
  }

  const faConf = fa.trade.confidence;
  const faRec = fa.trade.recommendation;
  if (faConf < config.minFAConfidence) return `skipped:fa_conf_${faConf}`;
  if (faRec === 'HOLD') return 'skipped:fa_hold';
  if (faRec !== signal) return `skipped:direction_mismatch`;

  const { entryPrice, stopLoss, targetPrice } = fa.trade;
  if (!entryPrice || !stopLoss || !targetPrice) return 'skipped:missing_levels';

  const dd = assessDrawdownMultiplier(positions);
  const sizing = calculatePositionSize(config, {
    price: entryPrice, mode, entryPrice, stopLoss,
    drawdownMultiplier: dd.multiplier,
  });
  if (sizing.quantity < 1) return 'skipped:size_too_small';

  if (!(await runPreTradeChecks(config, ticker, sizing.dollarSize, positions))) {
    return 'skipped:pre_trade_check';
  }

  const contract = await searchContract(ticker);
  if (!contract) return 'failed:no_contract';

  try {
    const result = await placeBracketOrder({
      symbol: ticker,
      side: signal,
      quantity: sizing.quantity,
      entryPrice,
      stopLoss,
      takeProfit: targetPrice,
      tif: mode === 'DAY_TRADE' ? 'DAY' : 'GTC',
    });

    await createPaperTrade({
      ticker, mode, signal,
      scanner_confidence: scannerConf,
      fa_confidence: faConf,
      fa_recommendation: faRec,
      entry_price: entryPrice,
      stop_loss: stopLoss,
      target_price: targetPrice,
      target_price2: fa.trade.targetPrice2,
      risk_reward: fa.trade.riskReward,
      quantity: sizing.quantity,
      position_size: sizing.dollarSize,
      ib_order_id: String(result.parentOrderId),
      status: 'SUBMITTED',
      scanner_reason: idea.reason,
      fa_rationale: fa.trade.rationale,
    });

    recordPendingOrder(sizing.dollarSize);
    log(`${ticker}: ORDER PLACED — ${signal} ${sizing.quantity} @ $${entryPrice}`);
    persistEvent(ticker, 'success', `Order placed: ${signal} ${sizing.quantity} @ $${entryPrice}`, {
      action: 'executed', source: 'scanner', mode,
      scanner_signal: signal, scanner_confidence: scannerConf,
      fa_recommendation: faRec, fa_confidence: faConf,
    });
    return 'executed';
  } catch (err) {
    log(`${ticker}: Order FAILED — ${err instanceof Error ? err.message : 'unknown'}`);
    return 'failed:order';
  }
}

async function executeSuggestedFindTrade(
  stock: SuggestedStock,
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
): Promise<string> {
  const { ticker, conviction } = stock;

  if (await hasActiveTrade(ticker)) return 'skipped:duplicate';

  // Conviction verification via trading-signals
  try {
    const freshFA = await fetchTradingSignal(ticker, 'SWING_TRADE');
    const freshConf = freshFA.trade?.confidence ?? 0;
    const freshRec = freshFA.trade?.recommendation ?? 'HOLD';
    if (freshRec === 'SELL') return 'skipped:fa_says_sell';
    if (conviction - freshConf >= 3) return `skipped:conviction_drop_${conviction}_to_${freshConf}`;
  } catch {
    // verification failed — proceed with cached conviction
  }

  const currentPrice = await getQuotePrice(ticker);
  if (!currentPrice) return 'failed:no_price';

  const dd = assessDrawdownMultiplier(positions);
  const sizing = calculatePositionSize(config, {
    price: currentPrice, mode: 'LONG_TERM', conviction,
    drawdownMultiplier: dd.multiplier,
  });

  if (!(await runPreTradeChecks(config, ticker, sizing.dollarSize, positions))) {
    return 'skipped:pre_trade_check';
  }

  const contract = await searchContract(ticker);
  if (!contract) return 'failed:no_contract';

  try {
    const result = await placeMarketOrder({
      symbol: ticker, side: 'BUY', quantity: sizing.quantity,
    });

    await createPaperTrade({
      ticker, mode: 'LONG_TERM', signal: 'BUY',
      scanner_confidence: conviction,
      fa_confidence: conviction,
      fa_recommendation: 'BUY',
      entry_price: currentPrice,
      quantity: sizing.quantity,
      position_size: sizing.dollarSize,
      ib_order_id: String(result.orderId),
      status: 'SUBMITTED',
      scanner_reason: `${stock.tag}: ${stock.reason}`,
      notes: `Long-term hold | ${stock.tag} | Conviction: ${conviction}/10 | ${stock.valuationTag}`,
    });

    recordPendingOrder(sizing.dollarSize);
    log(`${ticker}: SUGGESTED FIND BUY — ${sizing.quantity} shares @ ~$${currentPrice.toFixed(2)}`);
    persistEvent(ticker, 'success', `Suggested Find BUY: ${sizing.quantity} shares @ $${currentPrice.toFixed(2)}`, {
      action: 'executed', source: 'suggested_finds', mode: 'LONG_TERM',
    });
    return 'executed';
  } catch (err) {
    log(`${ticker}: Suggested Find order FAILED — ${err instanceof Error ? err.message : 'unknown'}`);
    return 'failed:order';
  }
}

async function executeExternalStrategySignal(
  signal: ExternalStrategySignal,
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
  options?: {
    allocationSplit?: number;
    allocationIndex?: number;
    allowDuplicateTicker?: boolean;
  },
): Promise<'executed' | 'skipped' | 'failed' | 'waiting'> {
  const ticker = signal.ticker.toUpperCase();
  const allocationSplit = Math.max(1, Math.floor(options?.allocationSplit ?? 1));
  const allocationIndex = Math.max(1, Math.floor(options?.allocationIndex ?? 1));
  const allowDuplicateTicker = options?.allowDuplicateTicker === true;
  const skipExternalSignal = async (failureReason: string, skipReason: string): Promise<'skipped'> => {
    await updateExternalStrategySignal(signal.id, {
      status: 'SKIPPED',
      failure_reason: failureReason,
    });
    persistEvent(ticker, 'warning', `External signal skipped: ${failureReason}`, {
      action: 'skipped',
      source: 'external_signal',
      mode: signal.mode,
      strategy_source: signal.source_name,
      strategy_source_url: signal.source_url,
      strategy_video_id: signal.strategy_video_id,
      strategy_video_heading: signal.strategy_video_heading,
      skip_reason: skipReason,
    });
    return 'skipped';
  };

  const markX = await shouldMarkStrategyX(signal);
  if (markX.blocked) {
    const reason = `Strategy marked X after ${markX.consecutiveLosses} consecutive losses (${markX.scope})`;
    await updateExternalStrategySignal(signal.id, {
      status: 'SKIPPED',
      failure_reason: reason,
    });
    persistEvent(ticker, 'warning', `External signal skipped: ${reason}`, {
      action: 'skipped',
      source: 'external_signal',
      mode: signal.mode,
      strategy_source: signal.source_name,
      strategy_source_url: signal.source_url,
      strategy_video_id: signal.strategy_video_id,
      strategy_video_heading: signal.strategy_video_heading,
      skip_reason: 'strategy_marked_x',
      metadata: {
        external_signal_id: signal.id,
        scope: markX.scope,
        consecutive_losses: markX.consecutiveLosses,
      },
    });
    return 'skipped';
  }

  if (allowDuplicateTicker) {
    const activeTrades = await getActiveTrades();
    const sameTickerTrades = activeTrades.filter(
      trade => trade.ticker.toUpperCase() === ticker
    );
    const hasConflict = sameTickerTrades.some(trade => (
      trade.mode !== signal.mode ||
      trade.signal !== signal.signal ||
      !trade.strategy_video_id
    ));
    if (hasConflict) {
      return skipExternalSignal('Duplicate active trade for ticker', 'duplicate_active_trade_conflict');
    }
  } else if (await hasActiveTrade(ticker)) {
    return skipExternalSignal('Duplicate active trade for ticker', 'duplicate_active_trade');
  }

  const hasProvidedLevels = (
    signal.entry_price != null &&
    signal.stop_loss != null &&
    signal.target_price != null
  );
  const requiresFaValidation = !hasProvidedLevels && (
    signal.mode === 'DAY_TRADE' || signal.mode === 'SWING_TRADE'
  );
  let validatedFA: TradingSignalsResponse['trade'] | null = null;

  if (requiresFaValidation) {
    try {
      const fa = await fetchTradingSignal(ticker, signal.mode);
      const faRec = fa.trade.recommendation;
      const faConf = fa.trade.confidence ?? 0;
      if (faConf < config.minFAConfidence) {
        return skipExternalSignal(`Full analysis confidence ${faConf} below minimum ${config.minFAConfidence}`, 'fa_confidence');
      }
      if (faRec === 'HOLD') {
        return skipExternalSignal('Full analysis recommendation is HOLD', 'fa_hold');
      }
      if (faRec !== signal.signal) {
        return skipExternalSignal(`Direction mismatch: external ${signal.signal} vs full analysis ${faRec}`, 'fa_direction_mismatch');
      }
      validatedFA = fa.trade;
    } catch (err) {
      const reason = `Full analysis validation failed: ${err instanceof Error ? err.message : 'unknown'}`;
      return skipExternalSignal(reason, 'fa_validation_failed');
    }
  }

  const effectiveEntryPrice = signal.entry_price ?? validatedFA?.entryPrice ?? null;
  const effectiveStopLoss = signal.stop_loss ?? validatedFA?.stopLoss ?? null;
  const effectiveTargetPrice = signal.target_price ?? validatedFA?.targetPrice ?? null;

  const quote = await getQuotePrice(ticker);
  if (effectiveEntryPrice != null && quote == null) {
    return 'waiting';
  }

  if (effectiveEntryPrice != null && quote != null) {
    if (signal.signal === 'BUY' && quote < effectiveEntryPrice) {
      return 'waiting';
    }
    if (signal.signal === 'SELL' && quote > effectiveEntryPrice) {
      return 'waiting';
    }
  }

  const referencePrice = quote ?? effectiveEntryPrice ?? null;
  if (!referencePrice || referencePrice <= 0) {
    await updateExternalStrategySignal(signal.id, {
      status: 'FAILED',
      failure_reason: 'Unable to resolve market/reference price',
    });
    return 'failed';
  }

  const dd = assessDrawdownMultiplier(positions);
  const baseSizing = signal.position_size_override && signal.position_size_override > 0
    ? (() => {
      const quantity = Math.max(1, Math.floor(signal.position_size_override! / referencePrice));
      return { quantity, dollarSize: quantity * referencePrice };
    })()
    : calculatePositionSize(config, {
      price: referencePrice,
      mode: signal.mode,
      conviction: signal.confidence,
      entryPrice: effectiveEntryPrice ?? undefined,
      stopLoss: effectiveStopLoss ?? undefined,
      drawdownMultiplier: dd.multiplier,
    });

  const splitDollarSize = baseSizing.dollarSize / allocationSplit;
  const splitQuantity = Math.floor(splitDollarSize / referencePrice);
  if (splitQuantity < 1 || splitDollarSize <= 0) {
    return skipExternalSignal(
      `Split allocation too small after dividing across ${allocationSplit} strategies`,
      'allocation_split_too_small',
    );
  }

  const sizing = {
    quantity: splitQuantity,
    dollarSize: splitQuantity * referencePrice,
  };

  if (sizing.quantity < 1 || sizing.dollarSize <= 0) {
    await updateExternalStrategySignal(signal.id, {
      status: 'FAILED',
      failure_reason: 'Calculated size is invalid',
    });
    return 'failed';
  }

  if (!(await runPreTradeChecks(config, ticker, sizing.dollarSize, positions))) {
    await updateExternalStrategySignal(signal.id, {
      status: 'SKIPPED',
      failure_reason: 'Pre-trade risk checks blocked execution',
    });
    persistEvent(ticker, 'warning', 'External signal skipped by risk checks', {
      action: 'skipped',
      source: 'external_signal',
      mode: signal.mode,
      strategy_source: signal.source_name,
      strategy_source_url: signal.source_url,
      skip_reason: 'pre_trade_check',
    });
    return 'skipped';
  }

  const contract = await searchContract(ticker);
  if (!contract) {
    await updateExternalStrategySignal(signal.id, {
      status: 'FAILED',
      failure_reason: 'Ticker not found in IB contract search',
    });
    return 'failed';
  }

  try {
    const side = signal.signal;
    const hasBracketLevels = (
      effectiveEntryPrice != null &&
      effectiveStopLoss != null &&
      effectiveTargetPrice != null
    );

    let ibOrderId: string;
    const entryForRecord = effectiveEntryPrice ?? referencePrice;
    const splitLabel = allocationSplit > 1
      ? ` | allocation ${allocationIndex}/${allocationSplit}`
      : '';

    if (hasBracketLevels) {
      const result = await placeBracketOrder({
        symbol: ticker,
        side,
        quantity: sizing.quantity,
        entryPrice: effectiveEntryPrice!,
        stopLoss: effectiveStopLoss!,
        takeProfit: effectiveTargetPrice!,
        tif: signal.mode === 'DAY_TRADE' ? 'DAY' : 'GTC',
      });
      ibOrderId = String(result.parentOrderId);
    } else {
      const result = await placeMarketOrder({
        symbol: ticker,
        side,
        quantity: sizing.quantity,
      });
      ibOrderId = String(result.orderId);
    }

    const trade = await createPaperTrade({
      ticker,
      mode: signal.mode,
      signal: side,
      strategy_source: signal.source_name,
      strategy_source_url: signal.source_url,
      strategy_video_id: signal.strategy_video_id,
      strategy_video_heading: signal.strategy_video_heading,
      scanner_confidence: signal.confidence,
      fa_confidence: validatedFA?.confidence ?? null,
      fa_recommendation: validatedFA?.recommendation ?? null,
      entry_price: entryForRecord,
      stop_loss: effectiveStopLoss,
      target_price: effectiveTargetPrice,
      quantity: sizing.quantity,
      position_size: sizing.dollarSize,
      ib_order_id: ibOrderId,
      status: 'SUBMITTED',
      scanner_reason: `External strategy signal from ${signal.source_name}`,
      notes: signal.notes ? `External signal${splitLabel} | ${signal.notes}` : `External signal${splitLabel}`,
    });

    recordPendingOrder(sizing.dollarSize);
    await updateExternalStrategySignal(signal.id, {
      status: 'EXECUTED',
      executed_trade_id: trade.id,
      executed_at: new Date().toISOString(),
      failure_reason: null,
    });

    persistEvent(ticker, 'success', `External signal executed: ${side} ${sizing.quantity} @ $${entryForRecord.toFixed(2)}`, {
      action: 'executed',
      source: 'external_signal',
      mode: signal.mode,
      strategy_source: signal.source_name,
      strategy_source_url: signal.source_url,
      strategy_video_id: signal.strategy_video_id,
      strategy_video_heading: signal.strategy_video_heading,
      scanner_signal: side,
      scanner_confidence: signal.confidence,
      metadata: {
        external_signal_id: signal.id,
        allocation_split: allocationSplit,
        allocation_index: allocationIndex,
      },
    });
    return 'executed';
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    await updateExternalStrategySignal(signal.id, {
      status: 'FAILED',
      failure_reason: message,
    });
    persistEvent(ticker, 'error', `External signal failed: ${message}`, {
      action: 'failed',
      source: 'external_signal',
      mode: signal.mode,
      strategy_source: signal.source_name,
      strategy_source_url: signal.source_url,
      strategy_video_id: signal.strategy_video_id,
      strategy_video_heading: signal.strategy_video_heading,
      scanner_signal: signal.signal,
      scanner_confidence: signal.confidence,
      metadata: { external_signal_id: signal.id },
    });
    return 'failed';
  }
}

async function processExternalStrategySignals(
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
): Promise<void> {
  const pending = await getDueExternalStrategySignals();
  if (pending.length === 0) return;

  const executionOptionsBySignalId = new Map<string, {
    allocationSplit: number;
    allocationIndex: number;
    allowDuplicateTicker: boolean;
  }>();
  const strategyWindowByVideoId = new Map<string, {
    startMinutes: number;
    endMinutes: number;
    label: string;
  }>();
  try {
    const videos = await loadStrategyVideos();
    for (const video of videos) {
      const videoId = (video.videoId ?? '').trim();
      if (!videoId) continue;
      const startRaw = video.executionWindowEt?.start;
      const endRaw = video.executionWindowEt?.end;
      if (!startRaw || !endRaw) continue;
      const startMinutes = parseEtClockToMinutes(startRaw);
      const endMinutes = parseEtClockToMinutes(endRaw);
      if (startMinutes == null || endMinutes == null || endMinutes <= startMinutes) continue;
      strategyWindowByVideoId.set(videoId, {
        startMinutes,
        endMinutes,
        label: `${startRaw}-${endRaw} ET`,
      });
    }

    const genericVideoIds = new Set(
      videos
        .filter(video => video.strategyType === 'generic_strategy')
        .map(video => video.videoId),
    );
    const groups = new Map<string, ExternalStrategySignal[]>();
    for (const signal of pending) {
      if (!isGenericStrategySignal(signal, genericVideoIds)) continue;
      const key = [
        signal.ticker.toUpperCase(),
        signal.mode,
        signal.signal,
        signal.execute_on_date,
      ].join('::');
      const list = groups.get(key) ?? [];
      list.push(signal);
      groups.set(key, list);
    }

    for (const group of groups.values()) {
      if (group.length <= 1) continue;
      group.sort((a, b) => a.created_at.localeCompare(b.created_at));
      group.forEach((signal, idx) => {
        executionOptionsBySignalId.set(signal.id, {
          allocationSplit: group.length,
          allocationIndex: idx + 1,
          allowDuplicateTicker: true,
        });
      });
    }
  } catch (err) {
    log(`Generic allocation grouping fallback: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  let executed = 0;
  let skipped = 0;
  let failed = 0;
  let expired = 0;
  let waiting = 0;
  const nowMs = Date.now();
  const nowEtMinutes = getETMinutes();

  for (const signal of pending) {
    const executeAtMs = signal.execute_at ? new Date(signal.execute_at).getTime() : null;
    if (executeAtMs && nowMs < executeAtMs) {
      continue;
    }

    const expiresAtMs = signal.expires_at ? new Date(signal.expires_at).getTime() : null;
    if (expiresAtMs && nowMs > expiresAtMs) {
      await updateExternalStrategySignal(signal.id, {
        status: 'EXPIRED',
        failure_reason: 'Signal expired before execution window',
      });
      expired += 1;
      continue;
    }

    const strategyWindow = signal.strategy_video_id
      ? strategyWindowByVideoId.get(signal.strategy_video_id)
      : null;
    if (strategyWindow) {
      if (nowEtMinutes < strategyWindow.startMinutes) {
        waiting += 1;
        continue;
      }
      if (nowEtMinutes > strategyWindow.endMinutes) {
        await updateExternalStrategySignal(signal.id, {
          status: 'EXPIRED',
          failure_reason: `Signal outside strategy window (${strategyWindow.label})`,
        });
        expired += 1;
        continue;
      }
    }

    const result = await executeExternalStrategySignal(
      signal,
      config,
      positions,
      executionOptionsBySignalId.get(signal.id),
    );
    if (result === 'executed') executed += 1;
    if (result === 'skipped') skipped += 1;
    if (result === 'failed') failed += 1;
    if (result === 'waiting') waiting += 1;
    await new Promise(r => setTimeout(r, 1500));
  }

  if (executed + skipped + failed + expired + waiting > 0) {
    log(`External signals processed — executed:${executed} waiting:${waiting} skipped:${skipped} failed:${failed} expired:${expired}`);
  }
}

// ── Position Management (Sync + Dip Buy + Profit Take + Loss Cut) ──

async function syncPositions(
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
): Promise<void> {
  const activeTrades = await getActiveTrades();

  for (const trade of activeTrades) {
    const ibPos = positions.find(
      p => p.symbol.toUpperCase() === trade.ticker.toUpperCase()
    );

    if (ibPos && ibPos.position !== 0) {
      if (trade.status === 'SUBMITTED' || trade.status === 'PENDING') {
        await updatePaperTrade(trade.id, {
          status: 'FILLED',
          fill_price: ibPos.avgCost,
          filled_at: new Date().toISOString(),
        });
        log(`${trade.ticker}: Filled @ $${ibPos.avgCost.toFixed(2)}`);
      }

      if (trade.status === 'FILLED' && ibPos.mktPrice > 0 && trade.fill_price) {
        const qty = trade.quantity ?? 1;
        const isLong = trade.signal === 'BUY';
        const unrealizedPnl = isLong
          ? (ibPos.mktPrice - trade.fill_price) * qty
          : (trade.fill_price - ibPos.mktPrice) * qty;
        await updatePaperTrade(trade.id, {
          pnl: parseFloat(unrealizedPnl.toFixed(2)),
          pnl_percent: parseFloat(((unrealizedPnl / (trade.fill_price * qty)) * 100).toFixed(2)),
        });
      }
    } else if (trade.status === 'FILLED') {
      // Position gone — closed
      const closePrice = await getQuotePrice(trade.ticker);
      const fillPrice = trade.fill_price ?? trade.entry_price ?? 0;
      const qty = trade.quantity ?? 1;
      const isLong = trade.signal === 'BUY';
      const actual = closePrice ?? fillPrice;
      const pnl = isLong
        ? (actual - fillPrice) * qty
        : (fillPrice - actual) * qty;

      let closeReason: string = 'manual';
      if (trade.stop_loss && trade.target_price) {
        if (isLong) {
          if (actual >= trade.target_price) closeReason = 'target_hit';
          else if (actual <= trade.stop_loss) closeReason = 'stop_loss';
        } else {
          if (actual <= trade.target_price) closeReason = 'target_hit';
          else if (actual >= trade.stop_loss) closeReason = 'stop_loss';
        }
      }
      if (closeReason === 'manual' && pnl > 0) closeReason = 'target_hit';
      if (closeReason === 'manual' && pnl < 0) closeReason = 'stop_loss';

      const status = closeReason === 'stop_loss' ? 'STOPPED'
        : closeReason === 'target_hit' ? 'TARGET_HIT' : 'CLOSED';

      await updatePaperTrade(trade.id, {
        status, close_reason: closeReason, close_price: actual,
        closed_at: new Date().toISOString(),
        pnl: parseFloat(pnl.toFixed(2)),
        pnl_percent: fillPrice > 0 ? parseFloat(((pnl / (fillPrice * qty)) * 100).toFixed(2)) : null,
      });
      log(`${trade.ticker}: Closed (${closeReason}) — P&L $${pnl.toFixed(2)}`);
    } else if (trade.status === 'SUBMITTED') {
      // Stale day trades
      const tradeAge = Date.now() - new Date(trade.created_at).getTime();
      if (trade.mode === 'DAY_TRADE' && tradeAge > 86400000) {
        await updatePaperTrade(trade.id, {
          status: 'CLOSED', close_reason: 'manual',
          closed_at: new Date().toISOString(),
          notes: (trade.notes ?? '') + ' | Expired: DAY order not filled within 1 day',
        });
        log(`${trade.ticker}: Day trade expired`);
      }
    }
  }
}

async function checkDipBuyOpportunities(
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
): Promise<void> {
  if (!config.dipBuyEnabled || !config.accountId) return;
  const activeTrades = await getActiveTrades();
  const longTermFilled = activeTrades.filter(t => t.mode === 'LONG_TERM' && t.status === 'FILLED');

  const tiers = [
    { pct: config.dipBuyTier3Pct, sizePct: config.dipBuyTier3SizePct, label: 'Tier 3' },
    { pct: config.dipBuyTier2Pct, sizePct: config.dipBuyTier2SizePct, label: 'Tier 2' },
    { pct: config.dipBuyTier1Pct, sizePct: config.dipBuyTier1SizePct, label: 'Tier 1' },
  ];

  for (const trade of longTermFilled) {
    const ibPos = positions.find(p => p.symbol.toUpperCase() === trade.ticker.toUpperCase());
    if (!ibPos || ibPos.mktPrice <= 0 || ibPos.avgCost <= 0) continue;

    const dipPct = ((ibPos.mktPrice - ibPos.avgCost) / ibPos.avgCost) * 100;
    if (dipPct >= 0) continue;
    const absDip = Math.abs(dipPct);

    const triggered = tiers.find(t => absDip >= t.pct);
    if (!triggered) continue;

    // Cooldown
    const recentEvents = await getRecentDipBuyEvents(trade.ticker);
    if (recentEvents.length > 0) {
      const lastBuyTime = new Date(recentEvents[0].created_at).getTime();
      if (Date.now() - lastBuyTime < config.dipBuyCooldownHours * 3600000) continue;
    }

    // Max position check
    const maxPositionValue = Math.min(
      config.portfolioValue * (config.maxPositionPct / 100),
      config.maxTotalAllocation * 0.10,
    );
    if (Math.abs(ibPos.position) * ibPos.mktPrice >= maxPositionValue) continue;

    const originalQty = trade.quantity ?? Math.abs(ibPos.position);
    const addOnQty = Math.max(1, Math.floor(originalQty * (triggered.sizePct / 100)));
    const addOnDollar = addOnQty * ibPos.mktPrice;

    if (!(await checkAllocationCap(config, addOnDollar, trade.ticker, positions))) continue;

    try {
      const contract = await searchContract(trade.ticker);
      if (!contract) continue;

      const result = await placeMarketOrder({
        symbol: trade.ticker, side: 'BUY', quantity: addOnQty,
      });

      await createPaperTrade({
        ticker: trade.ticker, mode: 'LONG_TERM', signal: 'BUY',
        scanner_confidence: trade.scanner_confidence,
        fa_confidence: trade.fa_confidence,
        fa_recommendation: 'BUY',
        entry_price: ibPos.mktPrice,
        quantity: addOnQty, position_size: addOnDollar,
        ib_order_id: String(result.orderId),
        status: 'SUBMITTED',
        notes: `Dip buy ${triggered.label} at -${absDip.toFixed(1)}%`,
      });

      recordPendingOrder(addOnDollar);
      log(`${trade.ticker}: DIP BUY ${triggered.label} — +${addOnQty} shares at -${absDip.toFixed(1)}%`);
      persistEvent(trade.ticker, 'success', `Dip buy ${triggered.label}: +${addOnQty} shares`, {
        action: 'executed', source: 'dip_buy', mode: 'LONG_TERM',
        metadata: { tier: triggered.label, dipPct: absDip, addOnQty, addOnDollar },
      });
    } catch (err) {
      log(`${trade.ticker}: Dip buy failed — ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }
}

async function checkProfitTakeOpportunities(
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
): Promise<void> {
  if (!config.profitTakeEnabled || !config.accountId) return;
  const activeTrades = await getActiveTrades();
  const longTermFilled = activeTrades.filter(t => t.mode === 'LONG_TERM' && t.status === 'FILLED');

  const tiers = [
    { pct: config.profitTakeTier3Pct, trimPct: config.profitTakeTier3TrimPct, label: 'Tier 3' },
    { pct: config.profitTakeTier2Pct, trimPct: config.profitTakeTier2TrimPct, label: 'Tier 2' },
    { pct: config.profitTakeTier1Pct, trimPct: config.profitTakeTier1TrimPct, label: 'Tier 1' },
  ];

  for (const trade of longTermFilled) {
    const ibPos = positions.find(p => p.symbol.toUpperCase() === trade.ticker.toUpperCase());
    if (!ibPos || ibPos.mktPrice <= 0 || ibPos.avgCost <= 0) continue;

    const gainPct = ((ibPos.mktPrice - ibPos.avgCost) / ibPos.avgCost) * 100;
    if (gainPct <= 0) continue;

    const triggered = tiers.find(t => gainPct >= t.pct);
    if (!triggered) continue;

    // Check if already trimmed at this tier
    const pastEvents = await getPastTrimEvents(trade.ticker);
    if (pastEvents.some(e => e.metadata?.tier === triggered.label)) continue;

    const originalQty = trade.quantity ?? Math.abs(ibPos.position);
    const currentQty = Math.abs(ibPos.position);
    const minHoldQty = Math.ceil(originalQty * (config.minHoldPct / 100));
    const trimQty = Math.max(1, Math.floor(currentQty * (triggered.trimPct / 100)));
    const actualTrimQty = Math.min(trimQty, currentQty - minHoldQty);
    if (actualTrimQty < 1) continue;

    try {
      const contract = await searchContract(trade.ticker);
      if (!contract) continue;

      await placeMarketOrder({
        symbol: trade.ticker, side: 'SELL', quantity: actualTrimQty,
      });

      await createPaperTrade({
        ticker: trade.ticker, mode: 'LONG_TERM', signal: 'SELL',
        entry_price: ibPos.mktPrice,
        quantity: actualTrimQty,
        position_size: actualTrimQty * ibPos.mktPrice,
        status: 'SUBMITTED',
        notes: `Profit take ${triggered.label} at +${gainPct.toFixed(1)}%`,
      });

      log(`${trade.ticker}: PROFIT TAKE ${triggered.label} — sold ${actualTrimQty} shares at +${gainPct.toFixed(1)}%`);
      persistEvent(trade.ticker, 'success', `Profit take ${triggered.label}: sold ${actualTrimQty} shares`, {
        action: 'executed', source: 'profit_take', mode: 'LONG_TERM',
        metadata: { tier: triggered.label, gainPct, trimQty: actualTrimQty },
      });
    } catch (err) {
      log(`${trade.ticker}: Profit take failed — ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }
}

async function checkLossCutOpportunities(
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
): Promise<void> {
  if (!config.lossCutEnabled || !config.accountId) return;
  const activeTrades = await getActiveTrades();
  const eligible = activeTrades.filter(t =>
    (t.mode === 'LONG_TERM' || t.mode === 'SWING_TRADE') &&
    (t.status === 'FILLED' || t.status === 'PARTIAL')
  );

  const tiers = [
    { pct: config.lossCutTier3Pct, sellPct: config.lossCutTier3SellPct, label: 'Tier 3 (full exit)' },
    { pct: config.lossCutTier2Pct, sellPct: config.lossCutTier2SellPct, label: 'Tier 2' },
    { pct: config.lossCutTier1Pct, sellPct: config.lossCutTier1SellPct, label: 'Tier 1' },
  ];

  for (const trade of eligible) {
    const ibPos = positions.find(p => p.symbol.toUpperCase() === trade.ticker.toUpperCase());
    if (!ibPos || ibPos.mktPrice <= 0 || ibPos.avgCost <= 0) continue;

    const lossPct = ((ibPos.avgCost - ibPos.mktPrice) / ibPos.avgCost) * 100;
    if (lossPct <= 0) continue;

    // Min hold period
    if (trade.created_at) {
      const holdDays = (Date.now() - new Date(trade.created_at).getTime()) / 86400000;
      if (holdDays < config.lossCutMinHoldDays) continue;
    }

    const triggered = tiers.find(t => lossPct >= t.pct);
    if (!triggered) continue;

    const pastEvents = await getPastLossCutEvents(trade.ticker);
    if (pastEvents.some(e => e.metadata?.tier === triggered.label)) continue;

    const currentQty = Math.abs(ibPos.position);
    const sellQty = triggered.sellPct >= 100
      ? currentQty
      : Math.max(1, Math.floor(currentQty * (triggered.sellPct / 100)));
    if (sellQty < 1) continue;

    try {
      const contract = await searchContract(trade.ticker);
      if (!contract) continue;

      const side = ibPos.position > 0 ? 'SELL' : 'BUY';
      await placeMarketOrder({ symbol: trade.ticker, side: side as 'BUY' | 'SELL', quantity: sellQty });

      await createPaperTrade({
        ticker: trade.ticker, mode: trade.mode as 'LONG_TERM' | 'SWING_TRADE',
        signal: 'SELL', entry_price: ibPos.mktPrice,
        quantity: sellQty,
        position_size: sellQty * ibPos.mktPrice,
        status: 'SUBMITTED',
        notes: `Loss cut ${triggered.label} at -${lossPct.toFixed(1)}%`,
      });

      log(`${trade.ticker}: LOSS CUT ${triggered.label} — sold ${sellQty} shares at -${lossPct.toFixed(1)}%`);
      persistEvent(trade.ticker, 'success', `Loss cut ${triggered.label}: sold ${sellQty} shares`, {
        action: 'executed', source: 'loss_cut', mode: trade.mode,
        metadata: { tier: triggered.label, lossPct, sellQty },
      });
    } catch (err) {
      log(`${trade.ticker}: Loss cut failed — ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }
}

// ── Portfolio Snapshot ───────────────────────────────────

async function savePortfolioSnapshotQuiet(
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (_lastSnapshotDate === today) return;
  if (positions.length === 0) return;

  try {
    const activeTrades = await getActiveTrades();
    const totalValue = positions.reduce((sum, p) => sum + Math.abs(p.mktValue), 0);
    const totalPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

    await savePortfolioSnapshot({
      account_id: config.accountId,
      total_value: totalValue,
      total_pnl: totalPnl,
      positions: positions.map(p => ({
        ticker: p.symbol, qty: p.position, avgCost: p.avgCost,
        mktPrice: p.mktPrice, mktValue: p.mktValue,
        unrealizedPnl: p.unrealizedPnl,
      })),
      open_trade_count: activeTrades.length,
    });

    _lastSnapshotDate = today;
    log('Portfolio snapshot saved');
  } catch (err) {
    log(`Snapshot failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

// ── Daily Rehydration ────────────────────────────────────

async function runDailyRehydration(config: AutoTraderConfig): Promise<void> {
  const today = getETDateString();
  if (_lastRehydrationDate === today) return;
  if (!isPastMarketCloseET()) return;
  if (!config.accountId) return;

  // Just sync positions — AI analysis runs only in the frontend for now
  try {
    const positions = await getEnrichedPositions();
    await syncPositions(config, positions);
    _lastRehydrationDate = today;
    log('Daily rehydration complete');
  } catch (err) {
    log(`Rehydration failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

// ── Suggested Finds Pre-Generation ───────────────────────

async function preGenerateSuggestedFinds(
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
): Promise<void> {
  const today = getETDateString();
  if (_lastSuggestedFindsDate === today) return;
  if (getETMinutes() < 9 * 60) return; // before 9 AM ET

  try {
    log('Fetching today\'s Suggested Finds...');
    const stocks = await fetchDailySuggestions();

    if (!stocks || stocks.length === 0) {
      log('No Suggested Finds available today');
      _lastSuggestedFindsDate = today;
      return;
    }

    log(`Found ${stocks.length} Suggested Finds candidates`);

    if (config.enabled && config.accountId) {
      // Filter by conviction + valuation
      const minConv = config.minSuggestedFindsConviction;
      const topTickers = new Set<string>();
      const compounders = stocks.filter(s => s.tag === 'Steady Compounder');
      const goldMines = stocks.filter(s => s.tag !== 'Steady Compounder');
      if (compounders[0] && (compounders[0].conviction ?? 0) >= 8) topTickers.add(compounders[0].ticker);
      if (goldMines[0] && (goldMines[0].conviction ?? 0) >= 8) topTickers.add(goldMines[0].ticker);

      const qualified = stocks.filter(s => {
        const conv = s.conviction ?? 0;
        if (conv < minConv) return false;
        if (topTickers.has(s.ticker)) return true;
        const tag = (s.valuationTag ?? '').toLowerCase();
        return tag === 'deep value' || tag === 'undervalued';
      });

      const activeCount = await countActivePositions();
      const slots = config.maxPositions - activeCount;

      for (const stock of qualified.slice(0, Math.max(0, slots))) {
        const result = await executeSuggestedFindTrade(stock, config, positions);
        log(`  ${stock.ticker}: ${result}`);
        await new Promise(r => setTimeout(r, 2000)); // rate limit
      }
    }

    _lastSuggestedFindsDate = today;
  } catch (err) {
    log(`Suggested Finds failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

// ── Trade Execution Only (Realtime-triggered) ─────────────
// Runs when trade_scans is updated (e.g. user opens TradeIdeas and triggers refresh).
// Skips if scheduler cycle is already running — avoids double execution.

async function runTradeExecutionOnly(): Promise<void> {
  if (_running) return;
  if (!isConnected()) return;
  if (!isMarketHoursET()) return;

  const config = await loadConfig();
  if (!config.enabled || !config.accountId) return;

  _running = true;
  const startTime = Date.now();
  try {
    log('[Realtime] trade_scans updated — running trade execution');
    resetProcessedTickersIfNewDay();
    const positions = await getEnrichedPositions();

    let allIdeas: TradeIdea[] = [];
    try {
      const data = await fetchTradeIdeas();
      allIdeas = [...(data.dayTrades ?? []), ...(data.swingTrades ?? [])];
    } catch (err) {
      log(`[Realtime] Scanner fetch failed: ${err instanceof Error ? err.message : 'unknown'}`);
      return;
    }

    await autoQueueDailySignalsFromTrackedVideos();
    const genericQueuedTickers = await autoQueueGenericSignalsFromTrackedVideos(allIdeas, config);
    await processExternalStrategySignals(config, positions);

    const newIdeas = allIdeas.filter(i =>
      !_processedTickers.has(i.ticker) &&
      !genericQueuedTickers.has(i.ticker)
    );
    if (newIdeas.length > 0) {
      const activeCount = await countActivePositions();
      const slots = config.maxPositions - activeCount;
      if (slots > 0) {
        const qualified = newIdeas
          .filter(i => i.confidence >= config.minScannerConfidence)
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, slots);
        for (const idea of qualified) {
          _processedTickers.add(idea.ticker);
          const result = await executeScannerTrade(idea, config, positions);
          log(`  ${idea.ticker}: ${result}`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`[Realtime] Trade execution complete (${elapsed}s)`);
  } catch (err) {
    log(`[Realtime] Trade execution failed: ${err instanceof Error ? err.message : 'unknown'}`);
  } finally {
    _running = false;
    _lastRun = new Date();
  }
}

function subscribeToTradeScans(): void {
  if (_realtimeChannel) return;
  try {
    const sb = getSupabase();
    const channel = sb
      .channel('trade-scans-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'trade_scans' },
        () => {
          // Debounce: scanner writes day_trades + swing_trades, so we get 2 events
          if (_realtimeDebounceTimer) clearTimeout(_realtimeDebounceTimer);
          _realtimeDebounceTimer = setTimeout(() => {
            _realtimeDebounceTimer = null;
            runTradeExecutionOnly().catch(err =>
              console.error('[Realtime] Trade execution error:', err)
            );
          }, REALTIME_DEBOUNCE_MS);
        }
      )
      .subscribe();
    _realtimeChannel = channel;
    log('[Realtime] Subscribed to trade_scans — will execute when scanner refreshes');
  } catch (err) {
    log(`[Realtime] Subscription failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

function unsubscribeFromTradeScans(): void {
  if (_realtimeDebounceTimer) {
    clearTimeout(_realtimeDebounceTimer);
    _realtimeDebounceTimer = null;
  }
  if (_realtimeChannel) {
    _realtimeChannel.unsubscribe();
    _realtimeChannel = null;
    log('[Realtime] Unsubscribed from trade_scans');
  }
}

// ── Main Scheduler Cycle ─────────────────────────────────

async function runSchedulerCycle(): Promise<void> {
  if (_running) {
    log('Cycle already in progress — skipping');
    return;
  }

  _running = true;
  _runCount++;
  const startTime = Date.now();

  try {
    log(`═══ Cycle #${_runCount} starting ═══`);
    resetProcessedTickersIfNewDay();

    if (!isConnected()) {
      log('IB Gateway not connected — skipping cycle');
      _lastRunResult = 'skipped: IB disconnected';
      return;
    }

    const config = await loadConfig();
    if (!config.enabled) {
      log('Auto-trading disabled in config — skipping');
      _lastRunResult = 'skipped: disabled';
      return;
    }

    if (!config.accountId) {
      log('No IB account configured — skipping');
      _lastRunResult = 'skipped: no account';
      return;
    }

    // Get current IB positions (used throughout the cycle)
    const positions = await getEnrichedPositions();

    // 1. Pre-generate Suggested Finds (daily at ~9 AM ET)
    await preGenerateSuggestedFinds(config, positions);

    // 2. Sync positions — detect fills, closes, update P&L
    await syncPositions(config, positions);
    _pendingDeployedDollar = 0; // reset after sync — IB is source of truth

    // 3. Save daily portfolio snapshot
    await savePortfolioSnapshotQuiet(config, positions);

    // 4. Update portfolio value from IB positions
    if (positions.length > 0) {
      const totalMktValue = positions.reduce(
        (sum, p) => sum + Math.abs(p.position) * (p.mktPrice > 0 ? p.mktPrice : p.avgCost), 0
      );
      if (totalMktValue > 0) {
        const pv = Math.max(totalMktValue, config.portfolioValue);
        if (Math.abs(pv - config.portfolioValue) > 1000) {
          await saveConfigPartial({ portfolio_value: pv });
          log(`Portfolio value updated: $${pv.toLocaleString()}`);
        }
      }
    }

    // 5. Portfolio health check
    const health = assessDrawdownMultiplier(positions);
    if (health.level !== 'normal') {
      log(`Drawdown protection: ${health.level} (${health.pnlPct.toFixed(1)}%, multiplier: ${health.multiplier})`);
    }

    // Skip new trades outside market hours but still run position management
    if (!isMarketHoursET()) {
      log('Outside market hours — position management only');
      // Still run daily rehydration after close
      await runDailyRehydration(config);
      _lastRunResult = 'ok: position management only (outside market hours)';
      return;
    }

    // 6. Position management: dip buy, profit take, loss cut
    await checkDipBuyOpportunities(config, positions);
    await checkProfitTakeOpportunities(config, positions);
    await checkLossCutOpportunities(config, positions);

    // Load scanner ideas once per cycle (used by generic-video queue + scanner execution)
    let allIdeas: TradeIdea[] = [];
    let scannerIdeasLoaded = false;
    try {
      const data = await fetchTradeIdeas();
      allIdeas = [...(data.dayTrades ?? []), ...(data.swingTrades ?? [])];
      scannerIdeasLoaded = true;
    } catch (err) {
      log(`Scanner fetch failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }

    // 7. Auto-queue daily ticker/trigger signals from tracked strategy videos
    await autoQueueDailySignalsFromTrackedVideos();

    // 8. Auto-queue generic strategy videos via scanner candidates (paper-trading execution)
    const genericQueuedTickers = await autoQueueGenericSignalsFromTrackedVideos(allIdeas, config);

    // 9. Process externally supplied strategy signals (date/time gated)
    await processExternalStrategySignals(config, positions);

    // 10. Execute scanner ideas not already routed through generic strategies
    const newIdeas = allIdeas.filter(i =>
      !_processedTickers.has(i.ticker) &&
      !genericQueuedTickers.has(i.ticker)
    );
    if (newIdeas.length > 0) {
      const activeCount = await countActivePositions();
      const slots = config.maxPositions - activeCount;

      if (slots > 0) {
        const qualified = newIdeas
          .filter(i => i.confidence >= config.minScannerConfidence)
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, slots);

        for (const idea of qualified) {
          _processedTickers.add(idea.ticker);
          const result = await executeScannerTrade(idea, config, positions);
          log(`  ${idea.ticker}: ${result}`);
          await new Promise(r => setTimeout(r, 2000));
        }
      } else {
        log(`Max positions reached (${config.maxPositions}) — skipping scanner ideas`);
      }
    } else if (scannerIdeasLoaded) {
      log('No new scanner ideas');
    }

    // 11. Daily rehydration (after 4:15 PM ET)
    await runDailyRehydration(config);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    _lastRunResult = `ok (${elapsed}s)`;
    log(`═══ Cycle #${_runCount} complete (${elapsed}s) ═══`);

  } catch (err) {
    _lastRunResult = `error: ${err instanceof Error ? err.message : 'unknown'}`;
    log(`Cycle failed: ${_lastRunResult}`);
  } finally {
    _running = false;
    _lastRun = new Date();
  }
}
