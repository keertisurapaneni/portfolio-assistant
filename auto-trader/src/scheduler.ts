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
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isConnected,
  requestPositions,
  placeBracketOrder,
  placeMarketOrder,
  cancelOrder,
  getOrderFillPrice,
  getOrderFillPriceWithFallback,
  getPaperConnection,
  getLiveConnection,
  getConnectionForAccount,
  placeOptionsOrder,
  getDefaultAccount,
  type PositionData,
  type IBConnection,
} from './ib-connection.js';
import { getConnectionForMode, getAccountForMode, getPositionSizeConfig, assertLiveLossLimitNotBreached, isModeEnabled, type RoutedConnection } from './lib/mode-router.js';
import type { AccountType } from '../../shared/trade-types.js';
import {
  isConfigured,
  getSupabase,
  getSupabaseUrl,
  getSupabaseAnonKey,
  getSupabaseServiceRoleKey,
  loadConfig,
  saveConfigPartial,
  getActiveTrades,
  getLongTermExposureByTag,
  hasActiveTrade,
  hasRecentLoss,
  countRecentStopOuts,
  getTickerWinRate,
  countActivePositions,
  createPaperTrade,
  updatePaperTrade,
  upsertSwingMetrics,
  createAutoTradeEvent,
  type AutoTradeEventInput,
  type AutoTradeSource,
  getRecentDipBuyEvents,
  getPastTrimEvents,
  getPastLossCutEvents,
  getRecentClosedStrategyOutcomes,
  createExternalStrategySignal,
  findExternalStrategySignal,
  getDueExternalStrategySignals,
  getExternalStrategySignalById,
  updateExternalStrategySignal,
  savePortfolioSnapshot,
  getPerformance,
  upsertHeartbeat,
  writeScanEvaluations,
  upsertScannerWatchlistTicker,
  resetScannerWatchlistStreak,
  type ScanEvaluationStatus,
  type AutoTraderConfig,
  type ExternalStrategySignal,
  type PaperTrade,
  tradesTable,
} from './lib/supabase.js';
import { ACTIVE_STATUSES, CLOSED_STATUSES } from '../../shared/trade-status-sets.js';
import type { AutoTradeEventType } from '../../shared/auto-trade-events.js';
import {
  recalculatePerformance,
  analyzeCompletedTrade,
  analyzeUnreviewedTrades,
  updatePerformancePatterns,
} from './lib/feedback.js';
import { logLongTermPerformance } from './lib/performanceLog.js';
import { logClosedTradePerformance } from './lib/tradePerformanceLog.js';
import { recordTradeClose } from './lib/trade-closer.js';
import { generateSuggestedFinds, discoverDipStocks } from './lib/discovery.js';
import { fetchRecentDailyCandles, detectCandlePatterns } from './lib/candle-patterns.js';
import { runOptionsScan, autoTradeOption, getOptionsAutoTradeConfig } from './lib/options-scanner.js';
import { getOptionsChain } from './lib/options-chain.js';
import { runEarningsScan, closeExpiredEarningsPositions } from './lib/earnings-scanner.js';
import { runWatchlistScreener } from './lib/watchlist-screener.js';
import { runOptionsManageCycle } from './lib/options-manager.js';
import { runEndOfDayReconciliation } from './lib/reconcile-executions.js';
import { runDipWatcher } from './lib/dip-watcher.js';
import { checkSpxLevelSetups } from './lib/spx-level-scanner.js';
import { checkVwapConfluenceSetups, type ConfluenceResult } from './lib/vwap-confluence-scanner.js';
import { checkFibRetraceSetups, type FibRetraceResult } from './lib/fib-retrace-scanner.js';
import { checkEmaPullbackSetups, type EmaPullbackResult } from './lib/ema-pullback-scanner.js';
import { isInsideOrb } from './lib/orb.js';
import { evaluateVwapAlignment, detectVwapReclaim } from './lib/vwap.js';
import { checkTrendFilter } from './lib/trend-filter.js';
import { getStreakMultiplier } from './lib/streak-tracker.js';
import { getEconDayProfile } from './lib/econ-calendar.js';
import { finnhubFetch } from './lib/finnhub.js';
import { warmPositionPriceCache } from './routes/positions.js';
import { generateMorningBrief } from './lib/morning-brief.js';
import { validateOrder } from './lib/validateOrder.js';
import {
  runPennyDiscovery,
  checkPennyEntry,
  checkPennyExit,
  getPennySessionState,
  isPennySessionDone,
  getPennySessionSummary,
  recordPennyTradeResult,
  pennyPositionSize,
  type PennyCandidate,
  type IBGainerResult,
} from './lib/penny-scanner.js';

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
  // Pass 2 FA levels carried from scanner — present means skip redundant FA re-run
  entryPrice?: number | null;
  stopLoss?: number | null;
  targetPrice?: number | null;
  targetPrice2?: number | null;
  riskReward?: string | null;
  atr?: number | null;
  in_play_score?: number;
  pass1_confidence?: number;
  market_condition?: 'trend' | 'chop';
  volumeVs10dAvg?: number | null;
  volumeVsPriorPeak?: number | null;
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
  archetype?: string;
  high52w?: number;
  drawdownPct?: number;
  sector?: string;
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
  strategyType?: 'daily_signal' | 'daily_penny' | 'generic_strategy';
  timeframe?: 'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM';
  applicableTimeframes?: Array<'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM'>;
  executionWindowEt?: {
    start?: string;
    end?: string;
  };
  tradeDate?: string;
  extractedSignals?: DailyVideoSignal[];
  status?: string; // 'tracked' | 'deactivated' | etc. — only 'tracked' (or absent) are used
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
let _ibWasConnected = false; // watchdog: track previous connection state
let _lastCycleSummary: string[] = [];
let _runCount = 0;
let _cachedSpyChangePct: number | null = null;
let _cachedSpyChangePctAt: number = 0; // timestamp of last fetch
let _lastSuggestedFindsDate = '';
let _lastSnapshotDate = '';
let _lastRehydrationDate = '';
let _lastAutoTuneDate = '';
let _lastDeadmansAlertSent: Date | null = null;
let _pendingDeployedDollar = 0;
let _dailyDeployedDollar = 0;
let _dailyDeployedDate = '';
const _processedTickers = new Set<string>();
let _processedTickersDate = '';

/** Skip results that are time-dependent — the ticker should be retried in later cycles
 *  because market conditions (ORB breakout, volume, price movement) can change. */
const RETRYABLE_SKIP_PREFIXES = [
  'skipped:outside-market-hours',
  'skipped:inside_orb',
  'skipped:illiquid',
  'skipped:rr_',
  'skipped:price_too_far',
  'skipped:swing_chop',
  'skipped:swing_low_volume',
  'skipped:swing_volume_divergence',
  'skipped:market_direction_bearish',
  'skipped:market_direction_bullish',
  'failed:order',      // transient IB connectivity failure — retry next cycle
  'failed:no_contract', // IB connection down — retry when reconnected
];

function isRetryableSkip(result: string): boolean {
  return RETRYABLE_SKIP_PREFIXES.some(p => result.startsWith(p));
}

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const FINNHUB_KEY = process.env.FINNHUB_API_KEY ?? '';
const __dirname = dirname(fileURLToPath(import.meta.url));
const STRATEGY_X_CONSECUTIVE_LOSS_LIMIT = 3;
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

  // Transcript ingest: every 10 min, process strategy_videos with null video_heading
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const ingestScript = resolve(projectRoot, 'scripts', 'ingest_video.py');
  if (existsSync(ingestScript)) {
    cron.schedule('*/10 * * * *', () => {
      runTranscriptIngest(ingestScript).catch(err => {
        console.error('[Scheduler] Transcript ingest failed:', err);
      });
    });
    log('Transcript ingest: every 10 min (python scripts/ingest_video.py)');
    setTimeout(() => runTranscriptIngest(ingestScript).catch(() => {}), 60_000);
  } else {
    log('Transcript ingest skipped: scripts/ingest_video.py not found');
  }

  // Dip-entry watcher: every 5 minutes during market hours (10:00–15:55 ET)
  // Detects when watchlist stocks drop ≥5% from 20-day high within an uptrend.
  // Alerts fire to the Options Log tab so you can act on premium entries.
  cron.schedule('*/5 10-15 * * 1-5', () => {
    runDipWatcher().catch(err => {
      console.error('[Dip Watcher] Failed:', err);
    });
  }, { timezone: 'America/New_York' });
  log('Dip watcher: every 5 min 10:00–15:55 ET (detects ≥5% pullbacks in uptrends)');

  // 3:45 PM soft close — close losing day trades and near-target winners before power-hour chaos.
  // Runs 10 min before the hard EOD sweep (3:55 PM) so there's a fallback if soft close misses any.
  cron.schedule('45 15 * * 1-5', async () => {
    try {
      const positions = await getEnrichedPositions();
      await softCloseDayTrades(positions);
    } catch (err) {
      console.error('[SoftClose] Failed:', err instanceof Error ? err.message : err);
    }
  }, { timezone: 'America/New_York' });
  log('Day-trade soft close: 3:45 PM ET (losing + near-target positions)');

  // EOD day-trade auto-close: 3:55 PM ET on weekdays — hard backstop after soft close.
  // Mirrors browser scheduleDayTradeAutoClose — ensures positions close even when browser is shut.
  cron.schedule('55 15 * * 1-5', async () => {
    const config = await loadConfig();
    if (config.dayTradeAutoClose) {
      await closeAllDayTrades(config);
    } else {
      log('EOD day-trade sweep skipped (day_trade_auto_close disabled)');
    }
  }, { timezone: 'America/New_York' });

  // 4:05 PM safety sweep — catches day trades placed in the 3:55–4:00 PM window
  // that the primary EOD sweep missed (e.g. scanner fired at exactly 3:55 PM).
  // Market is closed; any remaining FILLED/SUBMITTED day trades must be marked closed.
  cron.schedule('5 16 * * 1-5', async () => {
    const config = await loadConfig();
    if (config.dayTradeAutoClose) {
      log('[EOD Safety] 4:05 PM sweep — catching any trades placed after 3:55 PM EOD run');
      await closeAllDayTrades(config);
    }
  }, { timezone: 'America/New_York' });

  // 4:05 PM — promote today's profitable day-trade tickers to the scanner watchlist
  // so they get re-scanned tomorrow. Runs after EOD close (3:55) settles.
  cron.schedule('5 16 * * 1-5', async () => {
    try {
      await promoteDayTradeGainersToWatchlist();
    } catch (err) {
      console.error('[Scheduler] promoteDayTradeGainersToWatchlist failed:', err instanceof Error ? err.message : err);
    }
  }, { timezone: 'America/New_York' });
  log('Day-trade gainer promotion: 4:05 PM ET (winners → scanner watchlist)');

  // 4:10 PM IB position-level reconciliation — queries IB directly to find any
  // short or long positions that survived the EOD sweep (the sweep only checks
  // paper_trades, so desynced records can leave orphaned positions). Runs while
  // extended hours still allow position queries.
  cron.schedule('10 16 * * 1-5', async () => {
    try {
      log('[EOD Position Check] Verifying no orphaned positions remain on IB...');
      const [shortResult, longResult] = await Promise.all([reconcileIBShorts(), reconcileIBLongs()]);
      const issues = [...shortResult.errors, ...longResult.errors];
      if (issues.length > 0) {
        log(`[EOD Position Check] ⚠️ Issues found: ${issues.join('; ')}`);
      }
    } catch (err) {
      console.error('[EOD Position Check] Failed:', err instanceof Error ? err.message : err);
    }

    // Auto-discard paper-only options trades that were never submitted to IB.
    // These are trades the scanner recorded when IB was offline or the contract
    // couldn't be resolved. If they weren't manually submitted by end of day,
    // the strike/premium data is stale — tomorrow's scan will find fresh opportunities.
    try {
      const sb = getSupabase();
      const { data: stale } = await sb
        .from('paper_trades')
        .select('id, ticker, option_strike, option_expiry, mode')
        .in('mode', ['OPTIONS_PUT', 'OPTIONS_CALL'])
        .in('status', ['FILLED', 'SUBMITTED'])
        .is('ib_order_id', null);

      if (stale?.length) {
        const now = new Date().toISOString();
        for (const row of stale as Array<{ id: string; ticker: string; option_strike: number; option_expiry: string; mode: string }>) {
          await sb.from('paper_trades').update({
            status: 'CANCELLED',
            close_reason: 'discarded',
            closed_at: now,
            notes: `[AUTO-DISCARD] Paper-only trade never submitted to IB — discarded at EOD`,
          }).eq('id', row.id);

          createAutoTradeEvent({
            ticker: row.ticker,
            event_type: 'info',
            action: 'skipped',
            source: 'scanner',
            mode: row.mode as 'OPTIONS_PUT' | 'OPTIONS_CALL',
            message: `🗑 ${row.ticker} $${row.option_strike}P exp ${row.option_expiry} auto-discarded at EOD — paper-only, never submitted to IB`,
            metadata: { tradeId: row.id, reason: 'eod_auto_discard' },
          }).catch(() => {});
        }
        log(`[EOD] Auto-discarded ${stale.length} paper-only options trade(s) never submitted to IB`);
      }
    } catch (err) {
      console.error('[EOD Auto-Discard] Failed:', err instanceof Error ? err.message : err);
    }
  }, { timezone: 'America/New_York' });
  log('EOD position check: 4:10 PM ET (IB-level short + long detection + paper-only options discard)');

  // EOD reconciliation — 4:15 PM ET: compare today's IB executions against paper_trades,
  // correct any fill_price / P&L discrepancies, and recalculate global performance.
  cron.schedule('15 16 * * 1-5', async () => {
    try {
      await runEndOfDayReconciliation();
    } catch (err) {
      console.error('[EOD Reconcile] Failed:', err instanceof Error ? err.message : err);
    }
  }, { timezone: 'America/New_York' });
  log('EOD reconciliation: 4:15 PM ET');

  // EOD loss analysis — 4:20 PM ET: if the day had more losers than winners across
  // multiple tickers, diagnose which strategy/signal type caused it and why.
  cron.schedule('20 16 * * 1-5', async () => {
    try {
      await runEndOfDayAnalysis();
    } catch (err) {
      console.error('[EOD Analysis] Failed:', err instanceof Error ? err.message : err);
    }
  }, { timezone: 'America/New_York' });
  log('EOD loss analysis: 4:20 PM ET');

  // Earnings IV-crush scanner — 2:30 PM ET, enter calendar spreads for tonight's AMC
  // and tomorrow morning's BMO earnings announcements.
  cron.schedule('30 14 * * 1-5', async () => {
    try {
      const cfg = await loadConfig();
      if (!isModeEnabled(cfg, 'EARNINGS_CALENDAR')) return;
      await runEarningsScan();
    } catch (err) {
      console.error('[EarningsScan] Scan failed:', err instanceof Error ? err.message : err);
    }
  }, { timezone: 'America/New_York' });

  // Earnings IV-crush exit — 9:45 AM ET, close all open calendar spreads from prior day.
  // IV crush has occurred by this point; the front-month premium has collapsed.
  cron.schedule('45 9 * * 1-5', async () => {
    try {
      await closeExpiredEarningsPositions();
    } catch (err) {
      console.error('[EarningsExit] Close failed:', err instanceof Error ? err.message : err);
    }
  }, { timezone: 'America/New_York' });

  console.log('[Scheduler] Started — every 15 min + 9:36 ET first-candle pass + 9:45 earnings exit + 14:30 earnings entry + 15:55 EOD close (weekdays)');

  // Morning brief — runs 8:00 AM ET weekdays, before market open
  // Fetches Finnhub news + earnings + economic calendar, synthesizes via Llama 70B
  cron.schedule('0 8 * * 1-5', async () => {
    try {
      log('[Scheduler] Running morning brief generation...');
      await generateMorningBrief();
    } catch (err) {
      console.error('[Scheduler] Morning brief failed:', err instanceof Error ? err.message : err);
    }
  }, { timezone: 'America/New_York' });
  log('Morning brief: weekdays 8:00 AM ET');

  // Startup catch-up: if the service starts after 8 AM on a weekday and no brief exists
  // yet today (e.g. after a restart), generate it immediately rather than waiting until tomorrow.
  setTimeout(async () => {
    try {
      const etDay = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
      const etMins = (() => {
        const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        return et.getHours() * 60 + et.getMinutes();
      })();
      const isWeekday = !['Sat', 'Sun'].includes(etDay);
      const isAfter8AmEt = etMins >= 8 * 60;
      const isBeforeEodEt = etMins < 17 * 60; // don't bother after 5 PM
      if (isWeekday && isAfter8AmEt && isBeforeEodEt) {
        log('[Scheduler] Startup catch-up: checking for missed morning brief...');
        await generateMorningBrief(); // no-op if already generated today
      }
    } catch (err) {
      console.error('[Scheduler] Morning brief catch-up failed:', err instanceof Error ? err.message : err);
    }
  }, 15_000); // 15s after startup — let IB connect first

  // Weekly watchlist screener — runs Monday 10:30 AM ET to surface new ticker candidates
  cron.schedule('30 10 * * 1', async () => {
    try {
      console.log('[Scheduler] Running weekly watchlist screener...');
      await runWatchlistScreener();
    } catch (err) {
      console.error('[Scheduler] Watchlist screener error:', err);
    }
  }, { timezone: 'America/New_York' });

  // Weekly calendar spread scan — Monday 11:00 AM ET (after options market stabilizes).
  // Phase 1: paper only, logs opportunities to activity feed for human review.
  cron.schedule('0 11 * * 1', async () => {
    try {
      log('[Scheduler] Running weekly calendar spread scan...');
      const { runCalendarSpreadScan } = await import('./lib/calendar-spread-scanner.js');
      const result = await runCalendarSpreadScan();
      log(`[Scheduler] Calendar scan done — ${result.opportunities.length} opportunities found`);
    } catch (err) {
      console.error('[Scheduler] Calendar spread scan error:', err instanceof Error ? err.message : err);
    }
  }, { timezone: 'America/New_York' });
  log('Calendar spread scan: every Monday 11:00 AM ET');

  // Credit spread scan — Mon-Fri 10:30 AM ET.
  // Scans for vertical credit spread entries (bull puts / bear calls).
  // Executes qualifying trades automatically (≥40% credit/width, trend-following pullbacks).
  cron.schedule('30 10 * * 1-5', async () => {
    try {
      log('[Scheduler] Running credit spread scan...');
      const { runCreditSpreadScan } = await import('./lib/credit-spread-scanner.js');
      const result = await runCreditSpreadScan(undefined, true);
      log(`[Scheduler] Credit spread scan done — ${result.opportunities.length} opportunities, executed top picks`);
    } catch (err) {
      console.error('[Scheduler] Credit spread scan error:', err instanceof Error ? err.message : err);
    }
  }, { timezone: 'America/New_York' });
  log('Credit spread scan: Mon-Fri 10:30 AM ET');

  // Credit spread position management — every 30 min during market hours.
  // Checks 50% profit-take, 100% stop-loss, and 21 DTE time exit rules.
  cron.schedule('0,30 10-16 * * 1-5', async () => {
    try {
      const { manageCreditSpreadPositions } = await import('./lib/credit-spread-scanner.js');
      await manageCreditSpreadPositions();
    } catch (err) {
      console.error('[Scheduler] Credit spread manager error:', err instanceof Error ? err.message : err);
    }
  }, { timezone: 'America/New_York' });
  log('Credit spread management: every 30 min, Mon-Fri 10-4 PM ET');

  // Weekly Compounder health check — runs Friday 3:30 PM ET (after most price action is done).
  // Reviews every active Steady Compounder: positive-close ratio, zombie flag, profit-trim hints.
  // Results are logged and persisted as auto_trade_events so the dashboard can surface them.
  cron.schedule('30 15 * * 5', async () => {
    try {
      log('[Scheduler] Running weekly Compounder health check...');
      await runCompoundersHealthCheck();
    } catch (err) {
      console.error('[Scheduler] Compounder health check failed:', err instanceof Error ? err.message : err);
    }
  }, { timezone: 'America/New_York' });
  log('Compounder health check: every Friday 3:30 PM ET');

  // Dead man's switch — alerts if no successful cycle in 2+ hours during market hours
  cron.schedule('*/30 * * * 1-5', async () => {
    try {
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const etHour = nowET.getHours();
      if (etHour < 9 || etHour >= 17) return;
      if (etHour === 9 && nowET.getMinutes() < 30) return;

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      if (_lastRun && _lastRun > twoHoursAgo) return;

      const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
      if (_lastDeadmansAlertSent && _lastDeadmansAlertSent > fourHoursAgo) return;

      _lastDeadmansAlertSent = new Date();
      const lastRunStr = _lastRun ? _lastRun.toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'never';
      await sendAlert(
        'deadmans_switch',
        '⚠️ Portfolio Engine: No activity in 2+ hours',
        `The auto-trader scheduler has not completed a successful cycle in over 2 hours during market hours.

Last successful run: ${lastRunStr} ET
Last result: ${_lastRunResult}
Cycle count: ${_runCount}

Possible causes:
- Auto-trader service crashed or was restarted
- IB Gateway went offline
- Server resource issue

Action needed: Check the auto-trader service and restart if necessary.`,
      );
    } catch { /* non-blocking */ }
  });

  // Realtime: execute trades immediately when scanner refreshes (e.g. from TradeIdeas UI)
  subscribeToTradeScans();

  // IB position reconciliation on startup (delayed 30s to let IB fully connect).
  // Catches any orphaned short OR long positions left over from a prior EOD sweep
  // failure. If market is closed (pre-market boot), both reconcilers defer and we
  // schedule a retry at 9:31 AM ET so positions don't accumulate all day.
  setTimeout(async () => {
    try {
      const [shortResult, longResult] = await Promise.all([reconcileIBShorts(), reconcileIBLongs()]);
      const deferred = shortResult.errors.length > 0 && shortResult.closed.length === 0
        || longResult.errors.length > 0 && longResult.closed.length === 0;
      if (deferred) {
        // Deferred (market closed) — schedule retry at 9:31 AM ET on next weekday
        const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const etDay = etNow.getDay();
        const etMins = etNow.getHours() * 60 + etNow.getMinutes();
        const marketOpenMin = 9 * 60 + 31; // 9:31 AM ET
        const isWeekday = etDay >= 1 && etDay <= 5;
        if (isWeekday && etMins < marketOpenMin) {
          const delayMs = (marketOpenMin - etMins) * 60_000;
          log(`[IBReconcile] Scheduling retry in ${Math.round(delayMs / 60_000)} min (at 9:31 AM ET)`);
          setTimeout(() => {
            Promise.all([
              reconcileIBShorts().catch(err => {
                console.error('[Scheduler] 9:31 AM short reconcile retry failed:', err instanceof Error ? err.message : err);
              }),
              reconcileIBLongs().catch(err => {
                console.error('[Scheduler] 9:31 AM long reconcile retry failed:', err instanceof Error ? err.message : err);
              }),
            ]);
          }, delayMs);
        } else if (!isWeekday) {
          log('[IBReconcile] Weekend — deferring reconciliation until Monday market open');
        }
      }
    } catch (err) {
      console.error('[Scheduler] Startup IB reconcile failed:', err instanceof Error ? err.message : err);
    }
  }, 30_000);

  // Run once on startup (delayed 10s to let IB connect)
  setTimeout(() => {
    runSchedulerCycle().catch(err => {
      console.error('[Scheduler] Initial cycle failed:', err);
    });
  }, 10_000);

  // ── Heartbeat — write to Supabase every 60s ─────────────────────────────
  // This lets the dashboard show "last seen X min ago" even when the HTTP
  // endpoint is unreachable, and lets a cloud-side pg_cron staleness checker
  // send an email alert when the service is completely down.
  async function writeHeartbeat() {
    const s = getSchedulerStatus();
    const activeTrades = await getActiveTrades().then(t => t.length).catch(() => 0);
    await upsertHeartbeat({
      status: s.lastResult.startsWith('error') ? 'error'
            : s.ibConnected ? 'ok' : 'degraded',
      ibConnected: s.ibConnected,
      activeTrades,
      lastCycleResult: s.lastResult,
      lastCycleAt: s.lastRun,
      runCount: s.runCount,
    });
  }
  // Write immediately on startup (so dashboard shows "just now" after a restart)
  setTimeout(() => writeHeartbeat().catch(() => {}), 5_000);
  // Then every 60s
  setInterval(() => writeHeartbeat().catch(() => {}), 60_000);
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

/**
 * Close all open DAY_TRADE positions with status FILLED.
 * Called by the 3:55 PM ET EOD sweep cron job.
 */
async function closeAllDayTrades(config: AutoTraderConfig): Promise<void> {
  log('EOD day-trade sweep: closing all open day trade positions…');

  // Close day trades on both paper and live accounts
  for (const acctType of ['paper', 'live'] as AccountType[]) {
    const conn = getConnectionForAccount(acctType);
    if (!conn.isConnected()) {
      if (acctType === 'paper') log('EOD sweep: paper IB not connected, skipping paper');
      continue;
    }

    const activeTrades = await getActiveTrades(acctType);
    const dayTrades = activeTrades.filter(t => (t.mode === 'DAY_TRADE' || t.mode === 'DAY_PENNY') && ['FILLED', 'SUBMITTED', 'PARTIAL'].includes(t.status));

    if (dayTrades.length === 0) {
      if (acctType === 'paper') log('EOD sweep: no open day trades (paper)');
      continue;
    }

    log(`EOD sweep [${acctType}]: ${dayTrades.length} open day trade(s) to close`);
    for (const trade of dayTrades) {
      try {
        const closeSide = trade.signal === 'BUY' ? 'SELL' : 'BUY';
        const qty = trade.quantity ?? 0;
        if (qty <= 0) {
          log(`EOD sweep: ${trade.ticker} — quantity is 0, skipping`);
          continue;
        }

        if (trade.status === 'SUBMITTED' || trade.status === 'PARTIAL') {
          const orderId = trade.ib_order_id ? parseInt(trade.ib_order_id, 10) : NaN;

          // Before cancelling, check if the order already filled in IB (race condition:
          // market orders can fill between placement and EOD sweep). If filled, treat as
          // OPEN so the sweep closes it properly rather than orphaning the position.
          let alreadyFilled = false;
          if (!Number.isNaN(orderId)) {
            try {
              const { getSupabase } = await import('./lib/supabase.js');
              const { data: existingFill } = await getSupabase()
                .from('ib_fills')
                .select('fill_price, quantity')
                .eq('order_id', orderId)
                .not('fill_price', 'is', null)
                .maybeSingle();
              if (existingFill) {
                alreadyFilled = true;
                log(`${trade.ticker}: EOD — order #${orderId} already filled in ib_fills @ $${(existingFill as { fill_price: number }).fill_price} — treating as OPEN, will close`);
                await updatePaperTrade(trade.id, {
                  status: 'OPEN',
                  fill_price: (existingFill as { fill_price: number }).fill_price,
                  quantity: (existingFill as { fill_price: number; quantity: number }).quantity,
                }, acctType);
              }
            } catch { /* non-fatal — fall through to cancel */ }
          }

          if (!alreadyFilled) {
            if (!Number.isNaN(orderId)) {
              try {
                conn.cancelOrder(orderId);
                log(`${trade.ticker}: EOD — cancelled open entry IB order #${orderId}`);
              } catch (cancelErr) {
                log(`${trade.ticker}: EOD — cancel IB order #${orderId} failed (${cancelErr instanceof Error ? cancelErr.message : 'unknown'}) — continuing`);
              }
            }
            await updatePaperTrade(trade.id, {
              status: 'CANCELLED',
              close_reason: 'never_filled',
              closed_at: new Date().toISOString(),
            }, acctType);
            log(`${trade.ticker}: EOD cancelled (unfilled SUBMITTED order — no IB position to close)`);
            continue;
          }
        }

        // Cancel bracket TP/SL orders to prevent duplicate sells during hard close
        if (trade.ib_tp_order_id) {
          try { conn.cancelOrder(parseInt(trade.ib_tp_order_id, 10)); log(`${trade.ticker}: EOD — cancelled bracket TP #${trade.ib_tp_order_id}`); }
          catch (e) { log(`${trade.ticker}: EOD — cancel TP #${trade.ib_tp_order_id} failed: ${e instanceof Error ? e.message : 'unknown'}`); }
        }
        if (trade.ib_sl_order_id) {
          try { conn.cancelOrder(parseInt(trade.ib_sl_order_id, 10)); log(`${trade.ticker}: EOD — cancelled bracket SL #${trade.ib_sl_order_id}`); }
          catch (e) { log(`${trade.ticker}: EOD — cancel SL #${trade.ib_sl_order_id} failed: ${e instanceof Error ? e.message : 'unknown'}`); }
        }

        let fillResult: { avgFillPrice: number } | null = null;
        try {
          fillResult = await conn.placeMarketOrder({ symbol: trade.ticker, side: closeSide, quantity: qty });
          log(`${trade.ticker}: EOD close filled [${acctType}] (${qty} shares ${closeSide}) @ $${fillResult.avgFillPrice.toFixed(2)}`);
        } catch (orderErr) {
          log(`EOD sweep: ${trade.ticker} — IB order failed (${orderErr instanceof Error ? orderErr.message : 'unknown'}) — will retry on next sweep`);
        }

        if (!fillResult) continue;

        await recordTradeClose({
          tradeId: trade.id,
          closePrice: fillResult.avgFillPrice,
          closeReason: 'eod_close',
          status: 'CLOSED',
          orderId: (fillResult as { orderId?: number }).orderId,
          accountType: acctType,
        });
        log(`${trade.ticker}: EOD closed [${acctType}] (${qty} shares ${closeSide}) @ $${fillResult.avgFillPrice.toFixed(2)}`);
      } catch (err) {
        log(`EOD sweep: ${trade.ticker} — close failed: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }
  }
}

// ── 3:45 PM Soft Close — close losing day trades before power-hour chaos ──────
//
// Runs 10 min before the hard EOD sweep (3:55 PM). Closes day trades that are:
//   a) losing (unrealizedPnl < 0) — lock the loss before spreads widen further
//   b) near target (≥75% of full-target gain) — take the money, don't gamble the last 25%
//
// Winning trades with room to run are left for the trailing stop or bracket.

async function softCloseDayTrades(positions: EnrichedPosition[]): Promise<void> {
  // Soft-close day trades on both paper and live accounts
  for (const acctType of ['paper', 'live'] as AccountType[]) {
    const conn = getConnectionForAccount(acctType);
    if (!conn.isConnected()) continue;

    const activeTrades = await getActiveTrades(acctType);
    const dayTrades = activeTrades.filter(t => (t.mode === 'DAY_TRADE' || t.mode === 'DAY_PENNY') && ['FILLED', 'SUBMITTED', 'PARTIAL'].includes(t.status));
    if (dayTrades.length === 0) continue;

    log(`[SoftClose:${acctType}] Checking ${dayTrades.length} open day trade(s) before power hour`);
    let closed = 0;

    for (const trade of dayTrades) {
      const ibPos = positions.find(p => p.symbol.toUpperCase() === trade.ticker.toUpperCase());
      if (!ibPos || ibPos.mktPrice <= 0) continue;

      const fillPrice    = trade.fill_price ?? trade.entry_price ?? 0;
      const targetPrice  = trade.target_price ?? 0;
      const currentPrice = ibPos.mktPrice;
      const isBuy        = trade.signal === 'BUY';

      const unrealizedPnl = isBuy
        ? (currentPrice - fillPrice) * (trade.quantity ?? 0)
        : (fillPrice - currentPrice) * (trade.quantity ?? 0);

      let nearTarget = false;
      if (fillPrice > 0 && targetPrice > 0) {
        const fullGain   = Math.abs(targetPrice - fillPrice);
        const actualGain = Math.abs(currentPrice - fillPrice);
        nearTarget = fullGain > 0 && actualGain / fullGain >= 0.75;
      }

      const shouldClose = unrealizedPnl < 0 || nearTarget;
      const reason      = unrealizedPnl < 0 ? `losing (${unrealizedPnl.toFixed(0)})` : `near target (75%+)`;

      if (!shouldClose) {
        log(`${trade.ticker}: [SoftClose] skip — P&L ${unrealizedPnl.toFixed(0)}, not near target`);
        continue;
      }

      const closeSide = isBuy ? 'SELL' : 'BUY';
      const qty       = trade.quantity ?? 0;
      if (qty <= 0) continue;

      // Cancel bracket TP/SL orders to prevent duplicate sells during soft close
      if (trade.ib_tp_order_id) {
        try { conn.cancelOrder(parseInt(trade.ib_tp_order_id, 10)); log(`${trade.ticker}: [SoftClose] cancelled bracket TP #${trade.ib_tp_order_id}`); }
        catch (e) { log(`${trade.ticker}: [SoftClose] cancel TP #${trade.ib_tp_order_id} failed: ${e instanceof Error ? e.message : 'unknown'}`); }
      }
      if (trade.ib_sl_order_id) {
        try { conn.cancelOrder(parseInt(trade.ib_sl_order_id, 10)); log(`${trade.ticker}: [SoftClose] cancelled bracket SL #${trade.ib_sl_order_id}`); }
        catch (e) { log(`${trade.ticker}: [SoftClose] cancel SL #${trade.ib_sl_order_id} failed: ${e instanceof Error ? e.message : 'unknown'}`); }
      }

      try {
        let fillResult: { avgFillPrice: number } | null = null;
        try {
          fillResult = await conn.placeMarketOrder({ symbol: trade.ticker, side: closeSide, quantity: qty });
          log(`${trade.ticker}: [SoftClose:${acctType}] close filled @ $${fillResult.avgFillPrice.toFixed(2)} — ${reason}`);
        } catch (orderErr) {
          log(`${trade.ticker}: [SoftClose] IB order failed (${orderErr instanceof Error ? orderErr.message : 'unknown'}) — will retry at 3:55 PM hard close`);
        }

        if (!fillResult) continue;

        await recordTradeClose({
          tradeId: trade.id,
          closePrice: fillResult.avgFillPrice,
          closeReason: 'soft_eod_close',
          status: 'CLOSED',
          orderId: (fillResult as { orderId?: number }).orderId,
          accountType: acctType,
        });
        log(`${trade.ticker}: [SoftClose:${acctType}] DB marked closed — ${reason} — fill $${fillResult.avgFillPrice.toFixed(2)}`);
        closed++;
      } catch (err) {
        log(`${trade.ticker}: [SoftClose] close failed — ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }
    log(`[SoftClose:${acctType}] Done — ${closed} position(s) closed`);
  }
}

// ── Stale Day-Trade Detector ───────────────────────────────────────────────────
//
// Catches day trades that are still FILLED from a prior trading day — meaning the
// EOD sweep failed (IB disconnected, server was off). Logs a warning alert so it
// shows up in the activity feed, then attempts a market-close.

async function checkStaleDayTrades(positions: EnrichedPosition[]): Promise<void> {
  const activeTrades = await getActiveTrades();
  const todayEt = getETDateString();

  const stale = activeTrades.filter(t => {
    if ((t.mode !== 'DAY_TRADE' && t.mode !== 'DAY_PENNY') || t.status !== 'FILLED') return false;
    const tradeDate = t.filled_at
      ? new Date(t.filled_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
      : null;
    return tradeDate !== null && tradeDate < todayEt;
  });

  if (stale.length === 0) return;

  log(`⚠️  [StaleCheck] ${stale.length} day trade(s) still FILLED from a prior day — EOD sweep likely failed`);

  for (const trade of stale) {
    const ibPos = positions.find(p => p.symbol.toUpperCase() === trade.ticker.toUpperCase());
    const tradeDate = trade.filled_at
      ? new Date(trade.filled_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
      : 'unknown';

    log(`  ${trade.ticker}: stale DAY_TRADE from ${tradeDate} — attempting close`);

    const fillPrice = trade.fill_price ?? trade.entry_price ?? 0;
    const isLong = trade.signal === 'BUY';
    const qty = trade.quantity ?? 0;

    // If IB position no longer exists, just mark closed in DB (position already gone)
    if (!ibPos || Math.abs(ibPos.position) === 0) {
      const staleClosePrice = await getQuotePrice(trade.ticker);
      const actual = staleClosePrice ?? fillPrice;
      await recordTradeClose({
        tradeId: trade.id,
        closePrice: actual,
        closeReason: 'stale_eod_reconcile',
        status: 'CLOSED',
        accountType: 'paper',
        overridePnlSource: staleClosePrice ? 'quote_fallback' : 'estimated',
      } as Parameters<typeof recordTradeClose>[0]);
      log(`  ${trade.ticker}: no IB position found — marked CLOSED (reconciled)`);
      continue;
    }

    const closeSide = isLong ? 'SELL' : 'BUY';
    if (qty <= 0) continue;

    try {
      const result = await placeMarketOrder({ symbol: trade.ticker, side: closeSide, quantity: qty });
      await recordTradeClose({
        tradeId: trade.id,
        closePrice: result.avgFillPrice,
        closeReason: 'stale_eod_close',
        status: 'CLOSED',
        orderId: result.orderId,
        accountType: 'paper',
      });
      log(`  ${trade.ticker}: stale position closed via market order @ $${result.avgFillPrice.toFixed(2)}`);
    } catch (err) {
      log(`  ${trade.ticker}: stale close failed — ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }
}

// ── IB Short Reconciliation ───────────────────────────────────────────────────
//
// Safety net for the scenario where EOD sweep orders failed (IB disconnected,
// server restart, etc.) AND paper_trades was already reset to CLOSED via SQL.
// In that state, `checkStaleDayTrades` finds nothing — but IB is still holding
// naked short positions that will lose money tomorrow.
//
// This function pulls ACTUAL IB positions and BUYs to cover any shorts it finds.
// ── Promote Day-Trade Gainers to Scanner Watchlist ───────────────────────────
//
// Runs at 4:05 PM ET after the EOD sweep settles. Queries today's closed
// day trades, upserts winners into scanner_watchlist (10-day TTL, win streak
// tracking), and resets consecutive_wins for losers already on the list.
// The trade-scanner edge function reads this table to expand its universe.

async function promoteDayTradeGainersToWatchlist(): Promise<void> {
  const todayEt = getETDateString();
  const sb = getSupabase();
  const { data: closedToday } = await sb
    .from('paper_trades')
    .select('ticker, pnl, strategy_source')
    .in('mode', ['DAY_TRADE', 'DAY_PENNY'])
    .in('status', [...CLOSED_STATUSES])
    .not('pnl', 'is', null)
    .gte('opened_at', `${todayEt}T00:00:00Z`);

  if (!closedToday || closedToday.length === 0) {
    log('[ScannerWatchlist] No closed day trades today — nothing to promote');
    return;
  }

  const bestByTicker = new Map<string, { pnl: number; source: string }>();
  for (const t of closedToday) {
    const tk = t.ticker.toUpperCase();
    const prev = bestByTicker.get(tk);
    const pnl = Number(t.pnl);
    if (!prev || pnl > prev.pnl) {
      bestByTicker.set(tk, { pnl, source: t.strategy_source ?? 'scanner' });
    }
  }

  const promoted: string[] = [];
  const streakReset: string[] = [];

  for (const [ticker, info] of bestByTicker) {
    if (info.pnl > 0) {
      try {
        await upsertScannerWatchlistTicker(ticker, info.pnl, `day_trade_gainer:${info.source}`);
        promoted.push(ticker);
      } catch (err) {
        log(`[ScannerWatchlist] Failed to upsert ${ticker}: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    } else {
      try {
        await resetScannerWatchlistStreak(ticker);
        streakReset.push(ticker);
      } catch { /* no-op if ticker not on watchlist */ }
    }
  }

  if (promoted.length > 0) {
    log(`[ScannerWatchlist] Promoted ${promoted.length} gainer(s): ${promoted.join(', ')}`);
    persistEvent('*', 'info', `Scanner watchlist: promoted ${promoted.length} day-trade gainer(s) — ${promoted.join(', ')}`, {
      action: 'executed', source: 'system', mode: 'DAY_TRADE',
      metadata: { promoted, streakReset },
    });
  }
  if (streakReset.length > 0) {
    log(`[ScannerWatchlist] Reset streak for ${streakReset.length} loser(s): ${streakReset.join(', ')}`);
  }
}

// Safe to call at any time: it only acts on negative (short) stock positions.
// Exposed via POST /api/scheduler/reconcile-ib so the user can trigger it from
// the UI or curl without waiting for tomorrow's stale-trade check.
//
// NOTE: Unlike reconcileIBLongs(), this function DOES auto-cover orphaned shorts.
// This is intentional: short positions carry unlimited downside risk. An untracked
// short can accumulate unbounded losses overnight or over a weekend. Auto-covering
// is a safety mechanism — the worst case of a false positive is a small realized
// loss on a position we meant to hold, which is far better than an unmonitored
// short blowing up. Longs have bounded risk (max loss = position value) so they
// only get logged for manual review, never auto-liquidated.

export async function reconcileIBShorts(): Promise<{ closed: string[]; errors: string[] }> {
  log('[IBReconcile] Fetching live IB positions…');

  let ibPositions: import('./ib-connection.js').PositionData[];
  try {
    ibPositions = await requestPositions();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    log(`[IBReconcile] Cannot fetch IB positions — ${msg}`);
    return { closed: [], errors: [`IB unavailable: ${msg}`] };
  }

  const allShorts = ibPositions.filter(p => p.position < 0 && p.secType === 'STK');

  if (allShorts.length === 0) {
    log('[IBReconcile] No short stock positions found — all clear');
    return { closed: [], errors: [] };
  }

  // Only cover OVERNIGHT orphaned shorts — NOT same-day intraday shorts.
  // Same-day shorts (opened after today's 9:30 AM ET market open) are intentional
  // DAY_TRADE shorts from scanner/influencer signals. Covering them here would close
  // perfectly valid trades (e.g. a Somesh SELL signal that went short at 9:30 AM).
  const todayOpenET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  todayOpenET.setHours(9, 30, 0, 0);
  const todayOpenUTC = new Date(todayOpenET.toLocaleString('en-US', { timeZone: 'UTC' }));

  // Query active SELL paper_trades opened today — these are known same-day shorts
  const { data: sameDaySellTrades } = await getSupabase()
    .from('paper_trades')
    .select('ticker')
    .eq('signal', 'SELL')
    .in('status', ['SUBMITTED', 'FILLED', 'PARTIAL'])
    .gte('opened_at', todayOpenUTC.toISOString());

  const sameDaySellTickers = new Set((sameDaySellTrades ?? []).map((t: { ticker: string }) => t.ticker.toUpperCase()));

  const shorts = allShorts.filter(p => {
    if (sameDaySellTickers.has(p.symbol.toUpperCase())) {
      log(`[IBReconcile] Skipping ${p.symbol} — active same-day SELL trade exists (intraday short, not an orphan)`);
      return false;
    }
    return true;
  });

  if (shorts.length === 0) {
    log('[IBReconcile] No overnight orphaned short positions found (same-day shorts excluded) — all clear');
    return { closed: [], errors: [] };
  }

  log(`[IBReconcile] Found ${shorts.length} overnight orphaned short(s): ${shorts.map(p => p.symbol).join(', ')}`);

  // Market-hour gate: MKT orders with TIF=DAY are rejected outside RTH.
  // If market is closed, log a critical alert and defer — the next startup
  // during market hours (or the pre-close sweep) will handle it.
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etDay = etNow.getDay();
  const etMins = etNow.getHours() * 60 + etNow.getMinutes();
  const marketOpenMin = 9 * 60 + 30;  // 9:30 AM ET
  const marketCloseMin = 16 * 60;     // 4:00 PM ET
  const isMarketOpen = etDay >= 1 && etDay <= 5 && etMins >= marketOpenMin && etMins < marketCloseMin;

  if (!isMarketOpen) {
    const tickers = shorts.map(p => `${p.symbol}(${Math.abs(p.position)})`).join(', ');
    const alertMsg = `[IBReconcile] ⚠️ CRITICAL: ${shorts.length} orphaned short position(s) detected AFTER HOURS: ${tickers}. Cannot place cover orders — market is closed. Will retry at next startup during market hours.`;
    log(alertMsg);

    // Only create one deferred alert per calendar day to avoid spamming on every restart
    const todayStr = etNow.toISOString().slice(0, 10);
    const { data: existing } = await getSupabase()
      .from('auto_trade_events')
      .select('id')
      .eq('ticker', 'SYSTEM')
      .gte('created_at', `${todayStr}T00:00:00Z`)
      .ilike('message', '%orphaned short%AFTER HOURS%')
      .limit(1);

    if (!existing?.length) {
      await createAutoTradeEvent({
        ticker: 'SYSTEM',
        event_type: 'error',
        action: 'failed',
        source: 'system',
        message: alertMsg,
        metadata: {
          reconcile_type: 'ib_short_reconcile_deferred',
          shorts: shorts.map(p => ({ symbol: p.symbol, qty: Math.abs(p.position), avgCost: p.avgCost })),
        },
      });
    }
    return { closed: [], errors: [`Market closed — ${shorts.length} short(s) deferred: ${tickers}`] };
  }

  const closed: string[] = [];
  const errors: string[] = [];

  const sb = getSupabase();
  for (const pos of shorts) {
    const qty = Math.abs(pos.position);
    log(`[IBReconcile] Covering short: ${pos.symbol} × ${qty} @ avg ${pos.avgCost}`);
    try {
      const { orderId: coverOrderId, avgFillPrice } = await placeMarketOrder({ symbol: pos.symbol, side: 'BUY', quantity: qty });
      // Short P&L: sold at avgCost, covered at avgFillPrice
      const coverPnl = parseFloat(((pos.avgCost - avgFillPrice) * qty).toFixed(2));
      log(`[IBReconcile] ✓ ${pos.symbol}: BUY ${qty} filled @ $${avgFillPrice.toFixed(2)} (orderId=${coverOrderId}), est P&L: $${coverPnl.toFixed(2)}`);
      closed.push(pos.symbol);

      // Find the orphaned SELL paper_trade for this ticker and mark it for EOD reconciliation.
      // The actual cover fill price will be written by runEndOfDayReconciliation (4:15 PM)
      // once the IB execution is available. We store the cover orderId so the reconciler
      // can match the fill by orderId in ib_fills.
      // Try to fetch IB's actual realized P&L from ib_fills (may already be present since fill completed)
      const { data: ibFillRow } = await sb
        .from('ib_fills')
        .select('realized_pnl')
        .eq('order_id', coverOrderId)
        .not('realized_pnl', 'is', null)
        .maybeSingle();
      const ibRealizedPnl: number | null = (ibFillRow as { realized_pnl: number | null } | null)?.realized_pnl ?? null;
      const finalPnl = ibRealizedPnl ?? coverPnl;
      const pnlSource = ibRealizedPnl != null ? 'ib_realized' : 'ib_fill_calculated';

      const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const { data: orphanTrades } = await sb
        .from('paper_trades')
        .select('id, fill_price, quantity')
        .eq('ticker', pos.symbol)
        .eq('signal', 'SELL')
        .in('status', ['CLOSED'])
        .or('close_price.is.null,close_price.eq.0')
        .gte('opened_at', since)
        .order('opened_at', { ascending: false })
        .limit(1);

      const orphan = (orphanTrades ?? [])[0] as { id: string; fill_price: number | null; quantity: number | null } | undefined;
      if (orphan) {
        await sb.from('paper_trades').update({
          close_reason: 'reconcile_cover',
          close_price: avgFillPrice,
          pnl: finalPnl,
          pnl_percent: pos.avgCost > 0 ? parseFloat(((finalPnl / (pos.avgCost * qty)) * 100).toFixed(2)) : null,
          pnl_source: pnlSource,
          ib_order_id: String(coverOrderId),
          notes: `Cover orderId=${coverOrderId} filled @ $${avgFillPrice.toFixed(2)} by reconcileIBShorts at ${new Date().toISOString()}`,
        }).eq('id', orphan.id);
        log(`[IBReconcile] Linked cover orderId=${coverOrderId} to paper_trade ${orphan.id} for ${pos.symbol} (pnl $${finalPnl.toFixed(2)}, source=${pnlSource})`);
      } else {
        // No orphaned SELL paper_trade found — insert a new one so this cover appears
        // in Today's Activity with the correct IB P&L. The Postgres trigger will upgrade
        // pnl_source to 'ib_realized' if the realized_pnl arrives later via execDetails.
        const nowIso = new Date().toISOString();
        await sb.from('paper_trades').insert({
          ticker: pos.symbol,
          signal: 'BUY',
          mode: 'DAY_TRADE',
          quantity: qty,
          fill_price: avgFillPrice,
          close_price: avgFillPrice,
          pnl: finalPnl,
          pnl_source: pnlSource,
          status: 'CLOSED',
          ib_order_id: String(coverOrderId),
          close_reason: 'ib_reconciliation_cover',
          opened_at: nowIso,
          filled_at: nowIso,
          closed_at: nowIso,
          notes: `Short cover orderId=${coverOrderId} filled @ $${avgFillPrice.toFixed(2)} by reconcileIBShorts (avg cost $${pos.avgCost.toFixed(2)})`,
        });
        log(`[IBReconcile] Inserted cover paper_trade for ${pos.symbol} (pnl $${finalPnl.toFixed(2)}, source=${pnlSource})`);
      }

      await createAutoTradeEvent({
        ticker: pos.symbol,
        event_type: 'warning',
        action: 'closed',
        source: 'system',
        message: `[IBReconcile] Orphaned short covered: BUY ${qty} @ $${avgFillPrice.toFixed(2)} (avg cost $${pos.avgCost.toFixed(2)})`,
        metadata: { reconcile_type: 'ib_short_reconcile', qty, avg_cost: pos.avgCost, cover_order_id: coverOrderId, fillPrice: avgFillPrice, pnl: coverPnl },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      log(`[IBReconcile] ✗ ${pos.symbol}: BUY failed — ${msg}`);
      errors.push(`${pos.symbol}: ${msg}`);
    }
  }

  return { closed, errors };
}

// ── IB Long Reconciliation ────────────────────────────────────────────────────
//
// Mirror of reconcileIBShorts for orphaned LONG positions.
//
// How orphaned longs accumulate: the EOD sweep marks paper_trades as CLOSED in
// the DB, but if the IB close order failed silently (disconnection, rejection),
// the actual IB position stays LONG. The next day the auto-trader sees no open
// record for that ticker and re-enters — IB now holds 2x shares. When EOD fires
// both lots, IB uses FIFO (older cheaper lot first), showing a different P&L
// than what our DB expects. Confirmed to affect TSLA, AAPL, SMH on 2026-05-14.
//
// This function: queries IB for all live LONG stock positions, cross-references
// against active paper_trades, and SELLS any position that has no open record.

export async function reconcileIBLongs(): Promise<{ closed: string[]; errors: string[] }> {
  log('[IBLongReconcile] Fetching live IB positions…');

  let ibPositions: import('./ib-connection.js').PositionData[];
  try {
    ibPositions = await requestPositions();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    log(`[IBLongReconcile] Cannot fetch IB positions — ${msg}`);
    return { closed: [], errors: [`IB unavailable: ${msg}`] };
  }

  const longs = ibPositions.filter(p => p.position > 0 && p.secType === 'STK');

  if (longs.length === 0) {
    log('[IBLongReconcile] No long stock positions found — all clear');
    return { closed: [], errors: [] };
  }

  // Get all active paper_trades (FILLED, SUBMITTED, PARTIAL) so we know which
  // long positions are legitimately tracked by the auto-trader.
  const sb = getSupabase();
  const { data: activeTrades } = await sb
    .from('paper_trades')
    .select('ticker, signal, status, quantity')
    .in('status', ['FILLED', 'SUBMITTED', 'PARTIAL']);

  // Build a set of tickers with active LONG (BUY) paper_trades
  const activeLongTickers = new Set(
    (activeTrades ?? [])
      .filter((t: { signal: string }) => t.signal === 'BUY')
      .map((t: { ticker: string }) => t.ticker.toUpperCase())
  );

  // Find which untracked longs have a ghost paper_trade from TODAY with null fill_price.
  // These are positions where EOD swept a never-filled BUY order but IB still holds
  // a residual long (possible only if the entry was partially filled or if two orders
  // interleaved). These are the ONLY ones safe to auto-close — anything else could be a
  // legitimate long-term portfolio holding not tracked in paper_trades.
  const todayEt = getETDateString();
  const { data: todayGhostTrades } = await sb
    .from('paper_trades')
    .select('ticker')
    .eq('signal', 'BUY')
    .in('mode', ['DAY_TRADE', 'DAY_PENNY'])
    .is('fill_price', null)
    .in('status', ['CLOSED', 'CANCELLED'])
    .gte('opened_at', `${todayEt}T00:00:00Z`);
  const todayGhostTickers = new Set(
    (todayGhostTrades ?? []).map((t: { ticker: string }) => t.ticker.toUpperCase())
  );

  const untracked = longs.filter(p => !activeLongTickers.has(p.symbol.toUpperCase()));

  // Split into: confirmed EOD ghosts (auto-closeable) vs unrecognised portfolio positions (warn only)
  const confirmedGhosts = untracked.filter(p => todayGhostTickers.has(p.symbol.toUpperCase()));
  const unknownPositions = untracked.filter(p => !todayGhostTickers.has(p.symbol.toUpperCase()));

  if (unknownPositions.length > 0) {
    const symbols = unknownPositions.map(p => `${p.symbol}(${Math.round(p.position)})`).join(', ');
    log(`[IBLongReconcile] ⚠️ ${unknownPositions.length} unrecognised IB long position(s) — NOT auto-closing (could be portfolio holdings): ${symbols}`);
    await createAutoTradeEvent({
      ticker: '*',
      event_type: 'warning',
      action: 'skipped',
      source: 'system',
      message: `[IBLongReconcile] ${unknownPositions.length} IB long position(s) have no active paper_trade but are NOT ghost orders — manual review required: ${symbols}`,
      metadata: { symbols: unknownPositions.map(p => p.symbol) },
    });

    // Check if any unknown positions have a CLOSED paper_trade from the last 7 days
    // that likely represents a failed EOD close (DB marked CLOSED but IB still holds shares).
    // Classification:
    //   STALE_CLOSE — a CLOSED paper_trade exists within 7 days → auto-reopen
    //   UNKNOWN     — no recent paper_trade found → manual review required
    const unknownTickers = unknownPositions.map(p => p.symbol.toUpperCase());
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: failedCloses } = await sb
      .from('paper_trades')
      .select('id, ticker, status, close_price, close_reason, quantity')
      .eq('signal', 'BUY')
      .eq('status', 'CLOSED')
      .in('ticker', unknownTickers)
      .gte('opened_at', sevenDaysAgo)
      .order('opened_at', { ascending: false });

    const reopened: string[] = [];
    const staleCloseTickers = new Set<string>();
    for (const fc of (failedCloses ?? [])) {
      const ibPos = unknownPositions.find(p => p.symbol.toUpperCase() === fc.ticker.toUpperCase());
      if (!ibPos) continue;
      if (staleCloseTickers.has(fc.ticker.toUpperCase())) continue;
      const isSuspect = fc.close_price == null
        || ['eod_close', 'soft_eod_close'].includes(fc.close_reason ?? '');
      if (!isSuspect) continue;

      staleCloseTickers.add(fc.ticker.toUpperCase());
      await sb.from('paper_trades').update({
        status: 'FILLED',
        pnl: null,
        pnl_percent: null,
        closed_at: null,
        close_reason: null,
        close_price: null,
      }).eq('id', fc.id);
      reopened.push(fc.ticker);
      log(`[IBLongReconcile] REOPENED ${fc.ticker} — found stale-closed paper_trade ${fc.id}, IB still holds ${Math.round(ibPos.position)} shares [STALE_CLOSE]`);
    }

    // Log truly unknown orphans (no recent paper_trade) — manual review required
    const unknownOrphans = unknownPositions.filter(p => !staleCloseTickers.has(p.symbol.toUpperCase()));
    if (unknownOrphans.length > 0) {
      const symbols = unknownOrphans.map(p => `${p.symbol}(${Math.round(p.position)})`).join(', ');
      log(`[IBLongReconcile] ${unknownOrphans.length} UNKNOWN orphan(s) — no CLOSED paper_trade in last 7 days, manual review required: ${symbols}`);
    }

    if (reopened.length > 0) {
      await createAutoTradeEvent({
        ticker: reopened.join(','),
        event_type: 'warning',
        action: 'executed',
        source: 'system',
        message: `[IBLongReconcile] Reopened ${reopened.length} STALE_CLOSE trade(s) — IB still holds positions: ${reopened.join(', ')}`,
        metadata: { reopened, classification: 'STALE_CLOSE' },
      });
    }
  }

  if (confirmedGhosts.length === 0) {
    log('[IBLongReconcile] No confirmed ghost day-trade longs to close');
    return { closed: [], errors: [] };
  }

  log(`[IBLongReconcile] ${confirmedGhosts.length} confirmed ghost long(s) to close: ${confirmedGhosts.map(p => `${p.symbol}(${p.position})`).join(', ')}`);

  // Market-hour gate: MKT SELL orders require market to be open
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etDay  = etNow.getDay();
  const etMins = etNow.getHours() * 60 + etNow.getMinutes();
  const isMarketOpen = etDay >= 1 && etDay <= 5
    && etMins >= (9 * 60 + 30)
    && etMins < (16 * 60);

  if (!isMarketOpen) {
    const symbols = confirmedGhosts.map(p => `${p.symbol}(${Math.round(p.position)})`).join(', ');
    log(`[IBLongReconcile] Market closed — deferring ghost close for: ${symbols}`);
    return { closed: [], errors: [`Market closed — deferred: ${symbols}`] };
  }

  const closed: string[] = [];
  const errors: string[] = [];

  for (const pos of confirmedGhosts) {
    const qty = Math.round(pos.position);
    log(`[IBLongReconcile] Selling ghost long: ${pos.symbol} × ${qty} @ avg ${pos.avgCost}`);
    try {
      const fillResult = await placeMarketOrder({ symbol: pos.symbol, side: 'SELL', quantity: qty });
      log(`[IBLongReconcile] ✓ ${pos.symbol}: SELL ${qty} filled @ $${fillResult.avgFillPrice.toFixed(2)}`);
      closed.push(pos.symbol);

      const pnl = (fillResult.avgFillPrice - pos.avgCost) * qty;
      await createAutoTradeEvent({
        ticker: pos.symbol,
        event_type: 'warning',
        action: 'executed',
        source: 'system',
        message: `[IBLongReconcile] Ghost long sold: SELL ${qty} shares (avg cost ${pos.avgCost.toFixed(2)}, fill ${fillResult.avgFillPrice.toFixed(2)}, P&L $${pnl.toFixed(2)})`,
        metadata: { reconcile_type: 'ib_long_reconcile', qty, avg_cost: pos.avgCost, fill_price: fillResult.avgFillPrice, pnl },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      log(`[IBLongReconcile] ✗ ${pos.symbol}: SELL failed — ${msg}`);
      errors.push(`${pos.symbol}: ${msg}`);
    }
  }

  return { closed, errors };
}

// ── Daily Max-Loss Gate ────────────────────────────────────────────────────────
//
// Returns true if new day-trade entries should be blocked for the rest of the session.
// Compares today's realized P&L from closed day trades against dayTradeMaxDailyLoss.
// 0 = gate disabled.

let _dayTradeGateActive  = false;
let _dayTradeGateChecked = ''; // ET date of last check — reset daily

async function isDayTradeLossGateActive(config: AutoTraderConfig): Promise<boolean> {
  if (!config.dayTradeMaxDailyLoss || config.dayTradeMaxDailyLoss <= 0) return false;

  const todayEt = getETDateString();

  // Reset flag on new day
  if (_dayTradeGateChecked !== todayEt) {
    _dayTradeGateActive  = false;
    _dayTradeGateChecked = todayEt;
  }

  if (_dayTradeGateActive) return true; // already tripped today

  const sb       = getSupabase();
  const { data } = await sb
    .from('paper_trades')
    .select('pnl')
    .in('mode', ['DAY_TRADE', 'DAY_PENNY'])
    .eq('status', 'CLOSED')
    .gte('closed_at', `${todayEt}T00:00:00Z`);

  const sessionPnl = (data ?? []).reduce((s, t) => s + (t.pnl ?? 0), 0);

  if (sessionPnl < -config.dayTradeMaxDailyLoss) {
    _dayTradeGateActive = true;
    log(
      `🛑 [DailyLossGate] Session P&L $${sessionPnl.toFixed(0)} < -$${config.dayTradeMaxDailyLoss} ` +
      `— no new day-trade entries for the rest of today`,
    );
    return true;
  }

  return false;
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
    lastCycleSummary: _lastCycleSummary,
    runCount: _runCount,
    ibConnected: isConnected(),
    supabaseConfigured: isConfigured(),
  };
}

/** Trigger a manual run outside the cron schedule */
export async function triggerManualRun(): Promise<string> {
  if (_running) return 'already executing';
  if (!isMarketHoursET()) return 'skipped: outside market hours (9:30 AM – 4:30 PM ET)';
  try {
    await runSchedulerCycle();
    return 'completed';
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : 'unknown'}`;
  }
}

/**
 * Trigger just the options scan — lighter than a full scheduler cycle.
 * Called by the Options Wheel UI "refresh" button.
 * Runs outside market hours too so the user can test / verify the scan anytime.
 */
export async function triggerOptionsScan(): Promise<{ ok: boolean; opportunities: number; skipped: number; message: string }> {
  try {
    const config = await loadConfig();
    const owEnabled = isModeEnabled(config, 'OPTIONS_PUT') || isModeEnabled(config, 'OPTIONS_CALL') || isModeEnabled(config, 'CREDIT_SPREAD') || isModeEnabled(config, 'CALENDAR_SPREAD');
    if (!owEnabled) {
      return { ok: false, opportunities: 0, skipped: 0, message: 'Options Wheel module disabled' };
    }
    const optionsCapitalBudget = config.maxTotalAllocation ?? 550_000;
    const scanResult = await runOptionsScan(optionsCapitalBudget);

    const optsCfg = await getOptionsAutoTradeConfig();
    if (optsCfg.enabled) {
      const { maxContracts } = optsCfg;
      for (const opp of scanResult.opportunities.slice(0, maxContracts)) {
        await autoTradeOption(opp);
      }
    }

    return {
      ok: true,
      opportunities: scanResult.opportunities.length,
      skipped: scanResult.skipped.length,
      message: `Scan complete — ${scanResult.opportunities.length} qualified, ${scanResult.skipped.length} skipped`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    log(`[Manual Scan] Error: ${msg}`);
    return { ok: false, opportunities: 0, skipped: 0, message: msg };
  }
}

/** Force-execute an external strategy signal by ID (bypasses execution window). */
export async function forceExecuteSignal(signalId: string): Promise<{
  ok: boolean;
  result?: string;
  error?: string;
  executed?: boolean;
  reason?: string;
}> {
  // Manual force-execute: don't block on scheduler cycle — just run directly
  if (!isConnected()) return { ok: false, error: 'IB Gateway not connected' };
  const signal = await getExternalStrategySignalById(signalId);
  if (!signal) return { ok: false, error: 'Signal not found' };
  if (signal.status !== 'PENDING' && signal.status !== 'EXPIRED' && signal.status !== 'SKIPPED') {
    return { ok: false, error: `Signal status is ${signal.status} — cannot execute` };
  }
  const config = await loadConfig();
  if (!config.enabled) return { ok: false, error: 'Auto-trading disabled' };
  if (!config.accountId) return { ok: false, error: 'No IB account configured' };
  const positions = await getEnrichedPositions();
  // Re-open expired or skipped so executeExternalStrategySignal can retry
  if (signal.status === 'EXPIRED' || signal.status === 'SKIPPED') {
    await updateExternalStrategySignal(signalId, { status: 'PENDING', failure_reason: null });
  }
  const result = await executeExternalStrategySignal(signal, config, positions, {
    skipConfirmationGates: true,
  });
  const updated = result !== 'executed' ? await getExternalStrategySignalById(signalId) : null;
  return {
    ok: true,
    result,
    executed: result === 'executed',
    reason: updated?.failure_reason ?? (result === 'waiting' ? 'Waiting for confirmation (price/quote issue)' : undefined),
  };
}

// ── Helpers ──────────────────────────────────────────────

function log(msg: string): void {
  console.log(`[Scheduler] ${msg}`);
}

/** Log and append to lastCycleSummary (kept for status API, max 30 lines) */
function summaryLog(msg: string): void {
  log(msg);
  _lastCycleSummary.push(msg);
  if (_lastCycleSummary.length > 30) _lastCycleSummary.shift();
}

async function runTranscriptIngest(scriptPath: string): Promise<void> {
  const supabaseUrl = getSupabaseUrl();
  const supabaseKey = getSupabaseAnonKey();
  if (!supabaseUrl || !supabaseKey) return;

  const serviceKey = getSupabaseServiceRoleKey();
  const venvPython = resolve(dirname(scriptPath), '.venv', 'bin', 'python');
  const pythonCmd = existsSync(venvPython) ? venvPython : 'python3';
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonCmd, [scriptPath, '--from-strategy-videos'], {
      env: {
        ...process.env,
        SUPABASE_URL: supabaseUrl,
        SUPABASE_ANON_KEY: supabaseKey,
        ...(serviceKey && { SUPABASE_SERVICE_ROLE_KEY: serviceKey }),
        // Tell yt-dlp to pull Instagram cookies from Chrome (logged-in session).
        // Override by setting INSTAGRAM_COOKIES_BROWSER=safari (or firefox) in .env.
        // Set to 'none' to disable. Default: chrome on macOS.
        INSTAGRAM_COOKIES_BROWSER: process.env.INSTAGRAM_COOKIES_BROWSER ?? 'chrome',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    proc.stdout?.on('data', (d) => { out += d; });
    proc.stderr?.on('data', (d) => { err += d; });
    proc.on('close', (code) => {
      if (out) log(`[Ingest] ${out.trim().split('\n').join(' ')}`);
      if (err && code !== 0) console.error('[Ingest]', err.trim());
      if (code === 0) resolve();
      else reject(new Error(`ingest exit ${code}`));
    });
    proc.on('error', reject);
  });
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

import { formatDateToEtIso, getETDateString } from '../../shared/date-helpers.js';

/** Returns current ET time as "HH:MM" (24h) — used for entry-time pattern analysis */
function getETTimeString(): string {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Count trading days (Mon–Fri, excluding US market holidays) elapsed since `from`.
 * Covers 2025–2026. Non-blocking on weekends — a Saturday `from` still counts 0 for that day.
 */
function countTradingDaysSince(from: Date): number {
  const US_HOLIDAYS = new Set([
    '2025-01-01','2025-01-20','2025-02-17','2025-04-18','2025-05-26',
    '2025-06-19','2025-07-04','2025-09-01','2025-11-27','2025-12-25',
    '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25',
    '2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25',
  ]);
  let count = 0;
  const cur = new Date(from);
  cur.setHours(0, 0, 0, 0);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  while (cur < now) {
    cur.setDate(cur.getDate() + 1);
    const day = cur.getDay();
    if (day === 0 || day === 6) continue;
    if (!US_HOLIDAYS.has(cur.toISOString().slice(0, 10))) count++;
  }
  return count;
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
  const todayET = getETDateString();
  if (!isConfigured()) return [];
  const { data, error } = await getSupabase()
    .from('strategy_videos')
    .select('*')
    .eq('status', 'tracked');

  if (error) {
    log(`Failed to load strategy videos from DB: ${error.message}`);
    return [];
  }

  const rows = (data ?? []) as Array<{
    video_id: string;
    source_handle?: string | null;
    source_name?: string | null;
    reel_url?: string | null;
    canonical_url?: string | null;
    video_heading?: string | null;
    strategy_type?: string | null;
    timeframe?: string | null;
    applicable_timeframes?: string[] | null;
    execution_window_et?: { start?: string; end?: string } | null;
    trade_date?: string | null;
    extracted_signals?: unknown[] | null;
  }>;

  const mapped: StrategyVideoRecord[] = rows.map(r => ({
    videoId: r.video_id,
    sourceHandle: r.source_handle ?? undefined,
    sourceName: r.source_name ?? undefined,
    reelUrl: r.reel_url ?? undefined,
    canonicalUrl: r.canonical_url ?? undefined,
    videoHeading: r.video_heading ?? undefined,
    strategyType: (r.strategy_type === 'daily_signal' || r.strategy_type === 'daily_penny' || r.strategy_type === 'generic_strategy' ? r.strategy_type : undefined) as StrategyVideoRecord['strategyType'],
    timeframe: (r.timeframe === 'DAY_TRADE' || r.timeframe === 'SWING_TRADE' || r.timeframe === 'LONG_TERM' ? r.timeframe : undefined) as StrategyVideoRecord['timeframe'],
    applicableTimeframes: (() => {
      const arr = r.applicable_timeframes ?? [];
      const filtered = arr.filter((t): t is 'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM' =>
        t === 'DAY_TRADE' || t === 'SWING_TRADE' || t === 'LONG_TERM'
      );
      return filtered.length > 0 ? filtered : undefined;
    })(),
    executionWindowEt: r.execution_window_et ?? undefined,
    tradeDate: r.trade_date ?? undefined,
    extractedSignals: (r.extracted_signals ?? undefined) as DailyVideoSignal[] | undefined,
    status: 'tracked',
  }));

  // daily_signal / daily_penny videos expire after their trade date; generic_strategy are ongoing
  return mapped.filter(v => {
    if ((v.strategyType === 'daily_signal' || v.strategyType === 'daily_penny') && v.tradeDate) {
      const tradeDate = normalizeDateToEtIso(v.tradeDate);
      if (tradeDate && tradeDate < todayET) return false; // expired
    }
    return true;
  });
}

async function autoQueueDailySignalsFromTrackedVideos(): Promise<void> {
  const todayET = getETDateString();
  const videos = await loadStrategyVideos();
  const dailyVideos = videos.filter(v =>
    (v.strategyType === 'daily_signal' || v.strategyType === 'daily_penny') &&
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

      // Minimum stop distance: 0.3% of entry. Prevents zero-width brackets when the
      // influencer gives the same price for both long and short trigger (e.g. SPY 704.7
      // is both the breakout level AND the breakdown level). In that case stop_loss would
      // equal entry_price — the bracket stops out instantly on fill.
      const MIN_STOP_PCT = 0.003;

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
          const rawStop = setup.shortTriggerBelow ?? null;
          // Stop must be strictly below entry for a long. If equal or above, fall back to
          // MIN_STOP_PCT below entry so the bracket has meaningful room.
          const longStop = rawStop != null && rawStop < setup.longTriggerAbove
            ? rawStop
            : parseFloat((setup.longTriggerAbove * (1 - MIN_STOP_PCT)).toFixed(2));
          const stopNote = rawStop != null && rawStop >= setup.longTriggerAbove
            ? ` | stop adjusted: ${rawStop} >= entry ${setup.longTriggerAbove} → fallback ${longStop}`
            : '';
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
            stop_loss: longStop,
            target_price: setup.longTargets[0],
            execute_on_date: todayET,
            notes: `Auto from video ${video.videoId} | ${heading} | long breakout${stopNote}`,
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
          const rawStop = setup.longTriggerAbove ?? null;
          // Stop must be strictly above entry for a short. If equal or below, fall back to
          // MIN_STOP_PCT above entry.
          const shortStop = rawStop != null && rawStop > setup.shortTriggerBelow
            ? rawStop
            : parseFloat((setup.shortTriggerBelow * (1 + MIN_STOP_PCT)).toFixed(2));
          const stopNote = rawStop != null && rawStop <= setup.shortTriggerBelow
            ? ` | stop adjusted: ${rawStop} <= entry ${setup.shortTriggerBelow} → fallback ${shortStop}`
            : '';
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
            stop_loss: shortStop,
            target_price: setup.shortTargets[0],
            execute_on_date: todayET,
            notes: `Auto from video ${video.videoId} | ${heading} | short breakdown${stopNote}`,
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

// ── EV-based strategy scoring ─────────────────────────────
// Score each generic strategy video by expected value from the last 30 closed trades.
// EV = win_rate × avg_return_pct (only positive if win_rate > 0).
// Videos with < MIN_EV_SAMPLE trades get a neutral score and are still applied
// (we need data to learn from), but are ranked below proven performers.

const EV_SCORE_CACHE_MS = 30 * 60 * 1000; // refresh every 30 min
const MIN_EV_SAMPLE = 5;                    // min trades before EV score is trusted
const MAX_GENERIC_STRATEGIES_PER_TICKER = 3; // only apply top-N strategies per ticker
const EV_ANALYSIS_DAYS = 30;

let _evScoreCache: {
  scores: Map<string, { ev: number; trades: number; winRate: number; avgReturnPct: number }>;
  computedAt: number;
} | null = null;

async function getGenericStrategyEVScores(): Promise<
  Map<string, { ev: number; trades: number; winRate: number; avgReturnPct: number }>
> {
  const now = Date.now();
  if (_evScoreCache && now - _evScoreCache.computedAt < EV_SCORE_CACHE_MS) {
    return _evScoreCache.scores;
  }

  try {
    const sb = getSupabase();
    const since = new Date();
    since.setDate(since.getDate() - EV_ANALYSIS_DAYS);

    const { data, error } = await sb
      .from('paper_trades')
      .select('strategy_video_id, pnl, pnl_percent, fill_price')
      .in('status', [...CLOSED_STATUSES])
      .not('strategy_video_id', 'is', null)
      .not('fill_price', 'is', null)
      .not('pnl', 'is', null)
      .gte('closed_at', since.toISOString())
      .order('closed_at', { ascending: false })
      .limit(500);

    if (error || !data) {
      _evScoreCache = { scores: new Map(), computedAt: now };
      return _evScoreCache.scores;
    }

    // Group by strategy_video_id
    const byVideo = new Map<string, Array<{ pnl: number; pnl_percent: number }>>();
    for (const row of data as Array<{ strategy_video_id: string; pnl: number | null; pnl_percent: number | null; fill_price: number | null }>) {
      const vid = row.strategy_video_id;
      if (!vid || row.pnl == null) continue;
      if (!byVideo.has(vid)) byVideo.set(vid, []);
      byVideo.get(vid)!.push({ pnl: row.pnl, pnl_percent: row.pnl_percent ?? 0 });
    }

    const scores = new Map<string, { ev: number; trades: number; winRate: number; avgReturnPct: number }>();
    for (const [videoId, trades] of byVideo.entries()) {
      const wins = trades.filter(t => t.pnl > 0).length;
      const winRate = trades.length > 0 ? wins / trades.length : 0;
      const avgReturnPct = trades.reduce((s, t) => s + t.pnl_percent, 0) / trades.length;
      // EV: expected return per trade = simple average of all outcomes (wins + losses).
      // avgReturnPct already encapsulates both sides — multiplying by winRate again was wrong.
      const ev = trades.length >= MIN_EV_SAMPLE ? avgReturnPct : 0;
      scores.set(videoId, { ev, trades: trades.length, winRate, avgReturnPct });
    }

    _evScoreCache = { scores, computedAt: now };
    return scores;
  } catch {
    return _evScoreCache?.scores ?? new Map();
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
  const genericVideos = videos.filter(v => {
    if (v.strategyType !== 'generic_strategy') return false;
    // Guard: if a "generic_strategy" video has extracted_signals with concrete price
    // levels, it's actually a daily_signal that got misclassified by the LLM.
    // Don't use it as a generic strategy — it would incorrectly attribute every
    // scanner ticker to the influencer who made the daily signal video.
    const signals = v.extractedSignals ?? [];
    if (signals.some(s => s.longTriggerAbove != null || s.shortTriggerBelow != null)) {
      log(`Skipping video ${v.videoId} from generic queue — has concrete price levels (likely misclassified daily_signal)`);
      return false;
    }
    return true;
  });
  if (genericVideos.length === 0) return queuedTickers;

  // Load EV scores for all generic strategy videos
  const evScores = await getGenericStrategyEVScores();

  const bucketsByTimeframe = new Map<'DAY_TRADE' | 'SWING_TRADE', GenericBucket[]>();
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

    const scoreData = evScores.get(video.videoId);
    const ev = scoreData?.ev ?? 0;
    const evTrades = scoreData?.trades ?? 0;
    const evWinRate = scoreData?.winRate ?? 0;

    for (const timeframe of timeframes) {
      const list = bucketsByTimeframe.get(timeframe) ?? [];
      list.push({
        videoId: video.videoId,
        sourceName,
        sourceUrl,
        heading,
        timeframe,
        setupType: (video as { setupType?: string | null }).setupType ?? null,
        ev,
        evTrades,
        evWinRate,
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
    const active = await hasActiveTrade(ticker, { excludeOptions: true });
    activeTickerCache.set(ticker, active);
    return active;
  };

  for (const [timeframe, buckets] of bucketsByTimeframe.entries()) {
    if (buckets.length === 0) continue;
    const candidates = ideas
      .filter(i => i.mode === timeframe && i.confidence >= config.minScannerConfidence)
      .sort((a, b) => b.confidence - a.confidence);
    if (candidates.length === 0) continue;

    // Rank strategies by EV. Strategies with enough sample and positive EV rank first.
    // New/unproven strategies (< MIN_EV_SAMPLE trades) get neutral rank but still fire
    // so they can accumulate data.
    const rankedBuckets: GenericBucket[] = [...buckets].sort((a, b) => {
      // Proven positive EV > unproven > proven negative EV
      const aProven = a.evTrades >= MIN_EV_SAMPLE;
      const bProven = b.evTrades >= MIN_EV_SAMPLE;
      if (aProven && !bProven) return -1;
      if (!aProven && bProven) return 1;
      return b.ev - a.ev;
    });

    // Take top-N strategies, but always include at least one unproven strategy
    // to keep learning (prevent the system from getting stuck on old strategies)
    const topBuckets = selectTopStrategies(rankedBuckets);

    const seenTickers = new Set<string>();
    for (const candidate of candidates) {
      const ticker = candidate.ticker.trim().toUpperCase();
      if (!ticker) continue;
      if (seenTickers.has(ticker)) continue;
      seenTickers.add(ticker);
      if (await isActiveTicker(ticker)) continue;

      let createdForTicker = false;
      let existingForTicker = false;
      for (const bucket of topBuckets) {
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

        const evNote = bucket.evTrades >= MIN_EV_SAMPLE
          ? `ev=${bucket.ev.toFixed(2)} wr=${(bucket.evWinRate * 100).toFixed(0)}% n=${bucket.evTrades}`
          : `ev=unproven n=${bucket.evTrades}`;

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
          notes: `Generic strategy auto from video ${bucket.videoId} | ${bucket.heading} | scanner candidate: ${candidate.reason} | allocation group: ${topBuckets.length} | ${evNote}`,
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

type GenericBucket = {
  videoId: string;
  sourceName: string;
  sourceUrl: string | null;
  heading: string;
  timeframe: 'DAY_TRADE' | 'SWING_TRADE';
  setupType: string | null;
  ev: number;
  evTrades: number;
  evWinRate: number;
};

/**
 * Select top strategies from a ranked list:
 * - Take up to MAX_GENERIC_STRATEGIES_PER_TICKER proven strategies
 * - Always include at least 1 unproven strategy (to keep learning)
 * - Exclude strategies with proven negative EV (< -0.3) — they've earned the cut
 */
function selectTopStrategies(rankedBuckets: GenericBucket[]): GenericBucket[] {
  if (rankedBuckets.length <= MAX_GENERIC_STRATEGIES_PER_TICKER) return rankedBuckets;

  const proven = rankedBuckets.filter(b => b.evTrades >= MIN_EV_SAMPLE);
  const unproven = rankedBuckets.filter(b => b.evTrades < MIN_EV_SAMPLE);

  // Hard-cut strategies that have proven themselves to be money losers
  const viableProven = proven.filter(b => b.ev > -0.3);
  const topProven = viableProven.slice(0, MAX_GENERIC_STRATEGIES_PER_TICKER - 1);

  // Include one unproven strategy (round-robin by index to explore over time)
  const unprovenSlot = unproven.length > 0 ? [unproven[0]!] : [];

  return [...topProven, ...unprovenSlot];
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

function countConsecutiveLosses(outcomes: Array<{ pnl: number | null; closed_at?: string | null }>): number {
  // Group outcomes by calendar day (ET date from closed_at), then count consecutive days
  // where ALL trades on that day were losses. A winning trade on a day resets the streak.
  const byDay = new Map<string, number[]>();
  for (const outcome of outcomes) {
    const day = outcome.closed_at
      ? new Date(outcome.closed_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
      : 'unknown';
    const arr = byDay.get(day) ?? [];
    arr.push(outcome.pnl ?? 0);
    byDay.set(day, arr);
  }
  // Days sorted most-recent first (outcomes are already ordered desc by closed_at)
  const days = [...byDay.entries()];
  let lossDays = 0;
  for (const [, pnls] of days) {
    const dayPnl = pnls.reduce((s, v) => s + v, 0);
    if (dayPnl < 0) {
      lossDays += 1;
    } else {
      break;
    }
  }
  return lossDays;
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

  // Check exempt_from_auto_deactivation in strategy_videos (config-driven, no hardcoding)
  if (isConfigured()) {
    const { data } = await getSupabase()
      .from('strategy_videos')
      .select('source_name')
      .eq('exempt_from_auto_deactivation', true)
      .eq('status', 'tracked');
    const exemptSources = new Set((data ?? []).map((r: { source_name: string }) => r.source_name?.trim()).filter(Boolean));
    if (exemptSources.has(sourceName)) {
      return { blocked: false, scope: null, consecutiveLosses: 0 };
    }
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

// ── End-of-Day Loss Analysis ─────────────────────────────────────────────────
// Runs at 4:20 PM ET, after the EOD reconciliation settles.
// Piggybacks on the existing per-trade feedback loop (analyzeCompletedTrade /
// analyzeUnreviewedTrades / updatePerformancePatterns) — those already fire on
// every trade close and are stored in trade_learnings.
//
// This function adds the ONE missing piece: a daily *aggregate* check that
// detects when multiple tickers from the same strategy all lost on the same day
// and posts a single visible warning to auto_trade_events (shows in activity log).
async function runEndOfDayAnalysis(): Promise<void> {
  const sb = getSupabase();
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const todayISO = etNow.toISOString().slice(0, 10);

  // Ensure any trades that closed today have AI post-mortems in trade_learnings.
  // analyzeUnreviewedTrades + updatePerformancePatterns handle the per-trade layer.
  try {
    const analyzed = await analyzeUnreviewedTrades();
    if (analyzed > 0) {
      await updatePerformancePatterns();
      log(`[EOD Analysis] Analyzed ${analyzed} unreviewed trade(s) via existing feedback loop`);
    }
  } catch (err) {
    log(`[EOD Analysis] Per-trade analysis failed: ${err instanceof Error ? err.message : err}`);
  }

  // ── Aggregate daily check ────────────────────────────────────────────────
  const { data: closedToday } = await sb
    .from('paper_trades')
    .select('ticker, mode, signal, pnl, close_reason')
    .gte('closed_at', `${todayISO}T00:00:00`)
    .not('pnl', 'is', null)
    .not('status', 'in', '("CANCELLED","REJECTED","EXPIRED","SUBMITTED","PENDING")');

  if (!closedToday?.length) return;

  const totalPnl = closedToday.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const winners  = closedToday.filter(t => (t.pnl ?? 0) > 0);
  const losers   = closedToday.filter(t => (t.pnl ?? 0) < 0);

  // Only flag if it's a net losing day with multiple losers
  if (totalPnl >= 0 || losers.length < 2) {
    log(`[EOD Analysis] ${totalPnl >= 0 ? 'Net positive' : 'Single loser'} day — no systemic pattern to flag`);
    return;
  }

  // Group losses by mode:signal to spot strategy-level failures
  const byStrategy: Record<string, { wins: number; losses: number; pnl: number; tickers: string[]; stopOuts: number }> = {};
  for (const t of closedToday) {
    const key = `${t.mode}:${t.signal}`;
    if (!byStrategy[key]) byStrategy[key] = { wins: 0, losses: 0, pnl: 0, tickers: [], stopOuts: 0 };
    const pnl = t.pnl ?? 0;
    byStrategy[key].pnl += pnl;
    byStrategy[key].tickers.push(t.ticker);
    if (pnl > 0) byStrategy[key].wins++;
    else if (pnl < 0) {
      byStrategy[key].losses++;
      if (t.close_reason === 'stop_loss') byStrategy[key].stopOuts++;
    }
  }

  // Pull last 14 days of this strategy's performance for historical context
  const findings: string[] = [];
  for (const [key, stats] of Object.entries(byStrategy)) {
    if (stats.losses < 2 || stats.wins > 0) continue; // only flag all-loss groups

    const [mode, signal] = key.split(':');
    const { data: recent } = await sb
      .from('paper_trades')
      .select('pnl')
      .eq('mode', mode)
      .eq('signal', signal)
      .gte('closed_at', new Date(Date.now() - 14 * 86_400_000).toISOString())
      .not('pnl', 'is', null)
      .not('status', 'in', '("CANCELLED","REJECTED","EXPIRED","SUBMITTED","PENDING")');

    const recentAll  = recent ?? [];
    const recentWins = recentAll.filter(t => (t.pnl ?? 0) > 0).length;
    const recentRate = recentAll.length > 0 ? Math.round((recentWins / recentAll.length) * 100) : 0;

    findings.push(
      `${mode} ${signal}: ${stats.losses} losses, 0 wins today (${stats.tickers.join(', ')}) | $${stats.pnl.toFixed(0)} | ` +
      `14-day win rate: ${recentRate}% (${recentWins}/${recentAll.length})` +
      (stats.stopOuts >= 2 ? ` | ${stats.stopOuts} stop-outs — check entry timing & gap risk` : '')
    );
  }

  if (findings.length === 0) {
    log(`[EOD Analysis] Net loss day but no single strategy dominated — normal variance`);
    return;
  }

  const message = `📊 EOD: $${totalPnl.toFixed(0)} net | ${winners.length}W ${losers.length}L — Strategy issue detected:\n${findings.join('\n')}`;
  log(`[EOD Analysis] ${message}`);

  await createAutoTradeEvent({
    ticker: 'SYSTEM',
    mode: 'DAY_TRADE',
    event_type: 'warning',
    action: 'closed',
    source: 'scanner',
    message,
    metadata: { totalPnl, winners: winners.length, losers: losers.length, byStrategy, date: todayISO },
  });
}

async function getQuotePrice(symbol: string): Promise<number | null> {
  if (!FINNHUB_KEY) return null;
  const data = await finnhubFetch<{ c?: number }>(
    `${FINNHUB_BASE}/quote?symbol=${symbol.toUpperCase()}&token=${FINNHUB_KEY}`,
  );
  return data?.c && data.c > 0 ? data.c : null;
}

// ── Swing entry log (post-trade metrics — collect only) ──

interface SwingEntryLog {
  pct_distance_sma20_at_entry: number | null;
  macd_histogram_slope_at_entry: 'increasing' | 'decreasing' | null;
  volume_vs_10d_avg_at_entry: number | null;
  regime_alignment_at_entry: 'above_both' | 'below_both' | 'mixed' | null;
}

const SPY_REGIME_CACHE_MS = 15 * 60 * 1000;
let _spyBelowSma200Cache: { value: boolean; ts: number } | null = null;
let _vixCache: { value: number; ts: number } | null = null;

/**
 * Fetch VIX from Yahoo Finance (^VIX daily quote).
 * Returns 20 on failure (neutral — fail open).
 */
async function fetchVixLevel(): Promise<number> {
  if (_vixCache && Date.now() - _vixCache.ts < SPY_REGIME_CACHE_MS) {
    return _vixCache.value;
  }
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=5d&interval=1d&includePrePost=false';
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)' } });
    if (!res.ok) return 20;
    const data = await res.json();
    const closes: number[] = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
    const vix = closes.filter((c: number | null) => c != null).pop() ?? 20;
    _vixCache = { value: vix, ts: Date.now() };
    return vix;
  } catch { return 20; }
}

/**
 * Return a position-size multiplier based on current VIX level.
 * Mirrors the browser's getMarketRegime() logic so server sizing is regime-aware.
 *   VIX > 30 → 0.50 (panic   — halve size, limit damage)
 *   VIX > 25 → 0.65 (fear    — meaningfully reduced)
 *   VIX < 15 → 1.05 (calm    — slight boost, capped conservatively)
 *   otherwise → 1.00 (normal)
 */
async function getVixRegimeMultiplier(): Promise<number> {
  const vix = await fetchVixLevel();
  if (vix > 30) { log(`[Regime] VIX ${vix.toFixed(1)} — PANIC: sizing ×0.50`); return 0.50; }
  if (vix > 25) { log(`[Regime] VIX ${vix.toFixed(1)} — FEAR: sizing ×0.65`);  return 0.65; }
  if (vix < 15) return 1.05;
  return 1.0;
}

async function isSpyBelowSma200(): Promise<boolean> {
  if (_spyBelowSma200Cache && Date.now() - _spyBelowSma200Cache.ts < SPY_REGIME_CACHE_MS) {
    return _spyBelowSma200Cache.value;
  }
  const bars = await fetchYahooDailyBars('SPY');
  if (!bars || bars.closes.length < 200) return false; // fail open
  const closes = bars.closes;
  const price = closes[closes.length - 1];
  const sma200 = closes.slice(-200).reduce((a, b) => a + b, 0) / 200;
  const below = price < sma200;
  _spyBelowSma200Cache = { value: below, ts: Date.now() };
  return below;
}

async function fetchYahooDailyBars(symbol: string): Promise<{ closes: number[]; volumes: number[] } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&includePrePost=false`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const quotes = result.indicators?.quote?.[0] ?? {};
    const closes = (quotes.close ?? []).filter((c: number | null) => c != null) as number[];
    const volumes = (quotes.volume ?? []).map((v: number | null) => v ?? 0);
    if (closes.length < 30) return null;
    return { closes, volumes };
  } catch { return null; }
}

/**
 * Fetch SPY's intraday % change from previous close.
 * Used to check broad-market alignment before executing a day trade.
 * Returns null when data is unavailable — callers should proceed, not block.
 */
async function fetchSpyChangePct(): Promise<number | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=1d&interval=5m&includePrePost=false`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const prevClose: number | null = result.meta?.previousClose ?? null;
    const quotes = result.indicators?.quote?.[0] ?? {};
    const closes = (quotes.close ?? []).filter((c: number | null) => c != null) as number[];
    if (!prevClose || prevClose <= 0 || closes.length === 0) return null;
    const currentClose = closes[closes.length - 1];
    return parseFloat((((currentClose - prevClose) / prevClose) * 100).toFixed(2));
  } catch { return null; }
}

const SPY_CACHE_TTL_MS = 60_000; // refresh SPY quote at most once per minute

async function getCachedSpyChangePct(): Promise<number | null> {
  if (Date.now() - _cachedSpyChangePctAt < SPY_CACHE_TTL_MS && _cachedSpyChangePct !== null) {
    return _cachedSpyChangePct;
  }
  const pct = await fetchSpyChangePct();
  if (pct !== null) {
    _cachedSpyChangePct = pct;
    _cachedSpyChangePctAt = Date.now();
  }
  return pct;
}

const INDEX_ETFS = new Set(['SPY', 'QQQ', 'IWM', 'DIA']);

/**
 * Fetch SPY's 5-trading-day rolling change using daily close data.
 * Used to detect broad market selloffs that should pause Compounder stop-losses
 * (thesis-based holds shouldn't be stopped out by macro turbulence alone).
 * Returns null when data is unavailable — callers should proceed, not block.
 */
async function fetchSpy5DayChangePct(): Promise<number | null> {
  const bars = await fetchYahooDailyBars('SPY');
  if (!bars || bars.closes.length < 6) return null;
  const closes = bars.closes;
  const now = closes[closes.length - 1];
  const fiveDaysAgo = closes[closes.length - 6];
  if (!fiveDaysAgo || fiveDaysAgo <= 0) return null;
  return parseFloat((((now - fiveDaysAgo) / fiveDaysAgo) * 100).toFixed(2));
}

/**
 * Compute intraday volume pace vs 10-day average daily volume.
 * Returns the ratio of (current volume-per-minute) / (avg daily volume / 390 trading minutes).
 * Returns null when data is unavailable or fewer than 3 bars have printed (< 15 min elapsed).
 *
 * Ratio > 1.3 → stock is trading at above-average pace → volume confirmation.
 * Ratio < 1.0 → below-average pace → low-conviction setup, wait.
 */
async function fetchIntradayVolumeRatio(symbol: string): Promise<number | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m&includePrePost=false`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const quotes = result.indicators?.quote?.[0] ?? {};
    const volumes = (quotes.volume ?? []).filter((v: number | null) => v != null) as number[];
    // Need at least 3 completed 5-min bars (15 min) for meaningful data
    if (volumes.length < 3) return null;

    const todayVol = volumes.reduce((s: number, v: number) => s + v, 0);
    const elapsedMinutes = volumes.length * 5;
    const volPerMin = todayVol / elapsedMinutes;

    const dailyBars = await fetchYahooDailyBars(symbol);
    if (!dailyBars || dailyBars.volumes.length < 10) return null;
    const avgDailyVol = dailyBars.volumes.slice(-10).reduce((a: number, b: number) => a + b, 0) / 10;
    if (avgDailyVol <= 0) return null;

    const avgVolPerMin = avgDailyVol / 390; // 390 trading minutes in a session
    return volPerMin / avgVolPerMin;
  } catch { return null; }
}

function ema(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < period - 1; i++) out.push(NaN);
  out.push(prev);
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function macdHistogram(closes: number[]): number | null {
  if (closes.length < 35) return null;
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(isNaN(fast[i]) || isNaN(slow[i]) ? NaN : fast[i] - slow[i]);
  }
  const valid = macdLine.filter(v => !isNaN(v));
  if (valid.length < 9) return null;
  const sigEma = ema(valid, 9);
  const lastSig = sigEma[sigEma.length - 1];
  const lastMacd = valid[valid.length - 1];
  return lastMacd - lastSig;
}

async function computeSwingEntryLog(
  ticker: string,
  entryPrice: number,
): Promise<SwingEntryLog> {
  const out: SwingEntryLog = {
    pct_distance_sma20_at_entry: null,
    macd_histogram_slope_at_entry: null,
    volume_vs_10d_avg_at_entry: null,
    regime_alignment_at_entry: null,
  };

  const bars = await fetchYahooDailyBars(ticker);
  if (!bars || bars.closes.length < 20) return out;

  const closes = bars.closes;
  const volumes = bars.volumes;

  // % distance from SMA20 at entry
  const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  if (sma20 > 0) {
    out.pct_distance_sma20_at_entry = parseFloat((((entryPrice - sma20) / sma20) * 100).toFixed(2));
  }

  // MACD histogram slope (increasing/decreasing)
  const histNow = macdHistogram(closes);
  const histPrev = macdHistogram(closes.slice(0, -1));
  if (histNow != null && histPrev != null) {
    out.macd_histogram_slope_at_entry = histNow > histPrev ? 'increasing' : 'decreasing';
  }

  // Volume vs 10-day average on entry day
  if (volumes.length >= 11) {
    const entryVol = volumes[volumes.length - 1] || 0;
    const avgVol10 = volumes.slice(-11, -1).reduce((a, b) => a + b, 0) / 10;
    if (avgVol10 > 0) {
      out.volume_vs_10d_avg_at_entry = parseFloat((entryVol / avgVol10).toFixed(2));
    }
  }

  // Regime alignment (SPY above/below 50/200)
  const spyBars = await fetchYahooDailyBars('SPY');
  if (spyBars && spyBars.closes.length >= 200) {
    const spyCloses = spyBars.closes;
    const price = spyCloses[spyCloses.length - 1];
    const sma50 = spyCloses.slice(-50).reduce((a, b) => a + b, 0) / 50;
    const sma200 = spyCloses.slice(-200).reduce((a, b) => a + b, 0) / 200;
    const above50 = price > sma50;
    const above200 = price > sma200;
    if (above50 && above200) out.regime_alignment_at_entry = 'above_both';
    else if (!above50 && !above200) out.regime_alignment_at_entry = 'below_both';
    else out.regime_alignment_at_entry = 'mixed';
  }

  return out;
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

const VALID_EVENT_TYPES = new Set<AutoTradeEventType>(['info', 'success', 'warning', 'error']);

function isPermanentDbError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('violates check constraint')
    || msg.includes('Could not find the')
    || msg.includes('not-null constraint')
    || msg.includes('duplicate key');
}

// Dedup cache: prevents the same skip/warning from being persisted more than once
// per trading day. Key = "YYYY-MM-DD:ticker:eventType:message". Cleared at midnight.
const _persistedToday = new Set<string>();
let _persistDedupDate = '';

async function persistEvent(
  ticker: string,
  eventType: string,
  message: string,
  extra?: Omit<AutoTradeEventInput, 'ticker' | 'message'>,
  accountType: AccountType = 'paper',
): Promise<void> {
  const safeType = (VALID_EVENT_TYPES.has(eventType as AutoTradeEventType) ? eventType : 'info') as AutoTradeEventType;

  // For 'skipped' events, only persist once per ticker+reason per trading day
  if (eventType === 'skipped') {
    const etDate = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
    if (etDate !== _persistDedupDate) {
      _persistedToday.clear();
      _persistDedupDate = etDate;
    }
    const dedupKey = `${etDate}:${ticker}:${eventType}:${message}`;
    if (_persistedToday.has(dedupKey)) return;
    _persistedToday.add(dedupKey);
  }

  const payload: AutoTradeEventInput = { ticker, event_type: safeType, message, ...extra };
  const delays = [1000, 2000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await createAutoTradeEvent(payload, accountType);
      return;
    } catch (err) {
      const label = `${ticker}/${eventType}`;
      if (isPermanentDbError(err)) {
        log(`[persistEvent] ${label} PERMANENT failure (no retry): ${err instanceof Error ? err.message : err}`);
        return;
      }
      if (attempt < delays.length) {
        log(`[persistEvent] ${label} attempt ${attempt + 1} failed, retrying in ${delays[attempt]}ms: ${err instanceof Error ? err.message : err}`);
        await new Promise(r => setTimeout(r, delays[attempt]));
      } else {
        log(`[persistEvent] ${label} FAILED after ${attempt + 1} attempts: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
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

interface DailySuggestionsResult {
  stocks: SuggestedStock[];
  hasDipDiscoveries: boolean;
}

async function fetchDailySuggestions(): Promise<DailySuggestionsResult | null> {
  try {
    const url = `${getSupabaseUrl()}/functions/v1/daily-suggestions`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${getSupabaseAnonKey()}` },
    });
    const data = await res.json() as {
      cached: boolean;
      data?: { compounders?: SuggestedStock[]; goldMines?: SuggestedStock[]; dipDiscoveries?: SuggestedStock[] };
    };
    if (!data.cached || !data.data) return null;
    return {
      stocks: [
        ...(data.data.compounders ?? []),
        ...(data.data.goldMines ?? []),
        ...(data.data.dipDiscoveries ?? []),
      ],
      hasDipDiscoveries: (data.data.dipDiscoveries ?? []).length > 0,
    };
  } catch { return null; }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function patchDipDiscoveriesIntoCache(dips: any[]): Promise<void> {
  try {
    const today = getETDateString();
    const baseUrl = getSupabaseUrl();
    const serviceKey = getSupabaseServiceRoleKey();

    // Fetch current row using service role key to bypass RLS
    const getRes = await fetch(
      `${baseUrl}/rest/v1/daily_suggestions?suggestion_date=eq.${today}&category=eq.auto&select=id,data`,
      { headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } },
    );
    const rows = await getRes.json() as Array<{ id: string; data: Record<string, unknown> }>;
    if (!rows?.length) return;

    const row = rows[0];
    const updated = { ...row.data, dipDiscoveries: dips };

    await fetch(`${baseUrl}/rest/v1/daily_suggestions?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ data: updated }),
    });
    log('Patched dip discoveries into server cache');
  } catch (err) {
    console.warn('[DipDiscovery] Failed to patch cache:', err);
  }
}

// ── Position Sizing ──────────────────────────────────────

/** Gold Mine: cap at 1.25x. Steady Compounder: full up to 1.5x. Dip Discovery: cap at 1.0x. */
function convictionMultiplier(conv: number, suggestedFindTag?: 'Steady Compounder' | 'Gold Mine' | 'Dip Discovery'): number {
  let mult: number;
  if (conv >= 10) mult = 1.5;
  else if (conv >= 9) mult = 1.25;
  else if (conv >= 8) mult = 1.0;
  else if (conv >= 7) mult = 0.75;
  else mult = 0.5;
  if (suggestedFindTag === 'Gold Mine') mult = Math.min(mult, 1.25);
  if (suggestedFindTag === 'Dip Discovery') mult = Math.min(mult, 1.0);
  return mult;
}

function calculatePositionSize(
  config: AutoTraderConfig,
  params: {
    price: number;
    mode: 'LONG_TERM' | 'DAY_TRADE' | 'DAY_PENNY' | 'SWING_TRADE' | 'OPTIONS_PUT' | 'OPTIONS_CALL';
    conviction?: number;
    suggestedFindTag?: 'Steady Compounder' | 'Gold Mine' | 'Dip Discovery';
    entryPrice?: number;
    stopLoss?: number;
    regimeMultiplier?: number;
    drawdownMultiplier?: number;
    streakMultiplier?: number;
  }
): { quantity: number; dollarSize: number } {
  const {
    price, mode, conviction, suggestedFindTag, entryPrice, stopLoss,
    regimeMultiplier = 1.0, drawdownMultiplier = 1.0, streakMultiplier = 1.0,
  } = params;
  const alloc = config.maxTotalAllocation;
  const hardMaxDollar = alloc * 0.10;

  // Day trades are intraday — cap at positionSize (default $5,000) regardless of dynamic
  // sizing or risk-based formula. The risk-based formula can balloon when stops are tight
  // (e.g. $2 stop on a $200 stock → 2,750 shares), causing outsized day-trade losses.
  // Swing and long-term trades keep the larger allocation-based cap.
  const modeMaxDollar = mode === 'DAY_PENNY' ? config.pennyPositionSize
    : mode === 'DAY_TRADE' ? config.positionSize
    : hardMaxDollar;

  if (!config.useDynamicSizing || price <= 0) {
    const cappedSize = Math.min(config.positionSize, modeMaxDollar);
    const qty = Math.max(1, Math.floor(cappedSize / price));
    return { quantity: qty, dollarSize: qty * price };
  }

  const pv = config.portfolioValue;
  const maxDollar = Math.min(pv * (config.maxPositionPct / 100), modeMaxDollar);
  let dollarSize: number;

  if (mode === 'LONG_TERM' && conviction != null) {
    const base = alloc * (config.baseAllocationPct / 100);
    dollarSize = base * convictionMultiplier(conviction, suggestedFindTag);
    if (suggestedFindTag === 'Gold Mine') dollarSize *= 0.75 * 0.33; // 0.75 = Gold Mine tag discount; 0.33 = risk mgmt until Kelly > 0
    // Compounders historically lose money on big positions (>$5K: 20% WR, -$928)
    // but are profitable on small ones (<=$5K: 78% WR, +$1,589). Hard-cap at $3K.
    if (suggestedFindTag === 'Steady Compounder') dollarSize = Math.min(dollarSize, 3000);
    if (suggestedFindTag === 'Dip Discovery') dollarSize = Math.min(dollarSize, 5000);
  } else if (stopLoss && entryPrice && Math.abs(entryPrice - stopLoss) > 0) {
    const riskBudget = alloc * (config.riskPerTradePct / 100);
    const riskPerShare = Math.abs(entryPrice - stopLoss);
    const qty = Math.floor(riskBudget / riskPerShare);
    dollarSize = qty * price;
  } else {
    // No stop/entry levels — use base_allocation_pct so size scales with allocation,
    // not the static positionSize fallback.
    dollarSize = alloc * (config.baseAllocationPct / 100);
  }

  dollarSize = dollarSize * regimeMultiplier * drawdownMultiplier * streakMultiplier;
  dollarSize = Math.min(dollarSize, maxDollar);
  dollarSize = Math.max(dollarSize, 100);
  const quantity = Math.max(1, Math.floor(dollarSize / price));
  return { quantity, dollarSize: quantity * price };
}

// ── Allocation / Daily Limit Checks ──────────────────────

function recordPendingOrder(dollarSize: number): void {
  _pendingDeployedDollar += dollarSize;
  const today = getETDateString(); // ET date — trading day resets at ET midnight, not UTC
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

/**
 * Compute deployed capital split by bucket using paper_trades mode tags matched
 * against IB positions (cost basis). Falls back to position_size when IB unavailable.
 */
async function getDeployedByBucket(positions: EnrichedPosition[]): Promise<{
  longTerm: number;
  daySwing: number;
}> {
  const trades = await getActiveTrades();
  const ltTickers = new Set(
    trades.filter(t => t.mode === 'LONG_TERM').map(t => t.ticker.toUpperCase())
  );
  const dsTickers = new Set(
    trades.filter(t => t.mode !== 'LONG_TERM').map(t => t.ticker.toUpperCase())
  );

  if (positions.length > 0) {
    let longTerm = 0;
    let daySwing = 0;
    for (const p of positions) {
      const sym = p.symbol.toUpperCase();
      const cost = Math.abs(p.position) * p.avgCost;
      if (ltTickers.has(sym)) longTerm += cost;
      else if (dsTickers.has(sym)) daySwing += cost;
      else longTerm += cost; // unknown positions count as long-term (conservative)
    }
    return { longTerm, daySwing };
  }

  const longTerm = trades
    .filter(t => t.mode === 'LONG_TERM')
    .reduce((s, t) => s + (t.position_size ?? 0), 0);
  const daySwing = trades
    .filter(t => t.mode !== 'LONG_TERM')
    .reduce((s, t) => s + (t.position_size ?? 0), 0);
  return { longTerm, daySwing };
}

async function checkAllocationCap(
  config: AutoTraderConfig,
  positionSize: number,
  ticker: string,
  positions: EnrichedPosition[],
  mode: 'LONG_TERM' | 'DAY_TRADE' | 'SWING_TRADE' = 'DAY_TRADE',
): Promise<boolean> {
  const deployed = await getTotalDeployed(positions);
  const cap = config.maxTotalAllocation;

  // Overall circuit breaker — at 95%+ cap, try capital-pressure redeployment first.
  // Only swing trades are eligible (day trades close at EOD; long-term should be held).
  if (deployed >= cap * 0.95 || deployed + positionSize > cap) {
    if (mode === 'SWING_TRADE' && config.capitalPressureEnabled) {
      log(`Capital pressure triggered for ${ticker} — attempting to free $${positionSize.toFixed(0)}`);
      const freed = await makeRoomForTrade(config, positionSize, positions);
      if (freed >= positionSize * 0.8) {
        log(`Capital pressure: freed $${freed.toFixed(0)} — retrying allocation check for ${ticker}`);
        // Re-check deployed after the close (IB position will update on next cycle, use optimistic estimate)
        const newDeployed = Math.max(0, deployed - freed);
        if (newDeployed + positionSize <= cap) return true;
      }
    }
    if (deployed >= cap * 0.95) {
      log(`CIRCUIT BREAKER: ${ticker} — already at $${deployed.toFixed(0)} of $${cap} cap`);
      persistEvent(ticker, 'warning', 'Circuit breaker: at cap limit', {
        action: 'skipped', source: 'system',
        skip_reason: 'Circuit breaker: at cap limit',
      });
    } else {
      log(`Allocation cap hit for ${ticker}: $${deployed.toFixed(0)} + $${positionSize.toFixed(0)} > $${cap}`);
    }
    return false;
  }

  // Bucket cap — long-term gets longTermBucketPct, day/swing gets the rest.
  // When LONG_TERM is routed to 'off', LT bucket allocation flows to day/swing automatically.
  const effectiveLtPct = isModeEnabled(config, 'LONG_TERM') ? config.longTermBucketPct : 0;
  const buckets = await getDeployedByBucket(positions);
  if (mode === 'LONG_TERM') {
    const ltCap = cap * (effectiveLtPct / 100);
    if (buckets.longTerm + positionSize > ltCap) {
      log(`Long-term bucket cap for ${ticker}: $${buckets.longTerm.toFixed(0)} + $${positionSize.toFixed(0)} > $${ltCap.toFixed(0)} (${effectiveLtPct}% of $${cap})`);
      persistEvent(ticker, 'warning', `Long-term bucket full (${effectiveLtPct}% cap)`, {
        action: 'skipped', source: 'system',
        skip_reason: `Long-term bucket cap: ${effectiveLtPct}% of allocation`,
      });
      return false;
    }
  } else {
    const dsCap = cap * ((100 - effectiveLtPct) / 100);
    if (buckets.daySwing + positionSize > dsCap) {
      log(`Day/swing bucket cap for ${ticker}: $${buckets.daySwing.toFixed(0)} + $${positionSize.toFixed(0)} > $${dsCap.toFixed(0)} (${100 - effectiveLtPct}% of $${cap})`);
      persistEvent(ticker, 'warning', `Day/swing bucket full (${100 - effectiveLtPct}% cap)`, {
        action: 'skipped', source: 'system',
        skip_reason: `Day/swing bucket cap: ${100 - effectiveLtPct}% of allocation`,
      });
      return false;
    }
  }

  const today = getETDateString(); // ET date — consistent with recordPendingOrder
  if (_dailyDeployedDate !== today) { _dailyDeployedDollar = 0; _dailyDeployedDate = today; }
  if (_dailyDeployedDollar + positionSize > config.maxDailyDeployment) {
    log(`Daily limit for ${ticker}: $${_dailyDeployedDollar.toFixed(0)} + $${positionSize.toFixed(0)} > $${config.maxDailyDeployment}/day`);
    return false;
  }
  return true;
}

// ── Portfolio Health / Drawdown ──────────────────────────

// ── Half-Kelly Adaptive Sizing ───────────────────────────
// Cached so we don't re-query on every single trade in a cycle
let _kellyMultiplierCache: { value: number; computedAt: number } | null = null;
const KELLY_CACHE_MS = 15 * 60 * 1000; // refresh every 15 min

async function calculateKellyMultiplier(config: AutoTraderConfig): Promise<number> {
  if (!config.kellyAdaptiveEnabled) return 1.0;

  const now = Date.now();
  if (_kellyMultiplierCache && now - _kellyMultiplierCache.computedAt < KELLY_CACHE_MS) {
    return _kellyMultiplierCache.value;
  }

  try {
    const sb = getSupabase();
    // Use last 30 closed short-term results (exclude LONG_TERM — different risk profile)
    const { data, error } = await sb
      .from('paper_trades')
      .select('pnl_percent, fill_price, mode')
      .in('status', [...CLOSED_STATUSES])
      .in('mode', ['DAY_TRADE', 'DAY_PENNY', 'SWING_TRADE'])
      .not('pnl_percent', 'is', null)
      .not('fill_price', 'is', null)
      .order('closed_at', { ascending: false })
      .limit(30);

    if (error || !data || data.length < 10) {
      _kellyMultiplierCache = { value: 1.0, computedAt: now };
      return 1.0;
    }

    const wins  = data.filter(t => (t.pnl_percent ?? 0) > 0);
    const losses = data.filter(t => (t.pnl_percent ?? 0) < 0);
    if (wins.length === 0 || losses.length === 0) {
      _kellyMultiplierCache = { value: 1.0, computedAt: now };
      return 1.0;
    }

    const p = wins.length / data.length; // win rate
    const avgWin  = wins.reduce((s, t) => s + (t.pnl_percent ?? 0), 0) / wins.length;
    const avgLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl_percent ?? 0), 0) / losses.length);

    // Kelly fraction: f* = (p*b - (1-p)) / b   where b = avgWin/avgLoss (payoff ratio)
    const b = avgWin / avgLoss;
    const kelly = (p * b - (1 - p)) / b;

    // Half-Kelly for safety, clamped between 0.25x and 1.5x
    const halfKelly = kelly / 2;
    const mult = Math.max(0.25, Math.min(1.5, halfKelly));

    log(`[Kelly] n=${data.length} win%=${(p * 100).toFixed(0)}% avgWin=${avgWin.toFixed(1)}% avgLoss=${avgLoss.toFixed(1)}% b=${b.toFixed(2)} kelly=${kelly.toFixed(2)} half=${mult.toFixed(2)}x`);
    _kellyMultiplierCache = { value: mult, computedAt: now };
    return mult;
  } catch (e) {
    log(`[Kelly] failed to compute — defaulting to 1.0: ${e}`);
    _kellyMultiplierCache = { value: 1.0, computedAt: now };
    return 1.0;
  }
}

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
  const data = await finnhubFetch<{ finnhubIndustry?: string }>(
    `${FINNHUB_BASE}/stock/profile2?symbol=${ticker.toUpperCase()}&token=${FINNHUB_KEY}`,
  );
  if (data?.finnhubIndustry) {
    _sectorCache.set(ticker.toUpperCase(), data.finnhubIndustry);
    return data.finnhubIndustry;
  }
  return null;
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
    const data = await finnhubFetch<{
      earningsCalendar?: { date?: string; symbol?: string }[];
    }>(
      `${FINNHUB_BASE}/calendar/earnings?symbol=${ticker.toUpperCase()}&from=${from}&to=${to}&token=${FINNHUB_KEY}`,
    );
    if (!data) return true;
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
  mode: 'LONG_TERM' | 'DAY_TRADE' | 'SWING_TRADE' = 'DAY_TRADE',
): Promise<boolean> {
  const dd = assessDrawdownMultiplier(positions);
  // Critical drawdown blocks day/swing trades — but NOT long-term Suggested Finds.
  // Long-term buys are meant to be held for months; a short-term drawdown on active
  // day trades should not prevent deploying idle cash into a long-term thesis.
  if (dd.level === 'critical' && mode !== 'LONG_TERM') {
    log(`DRAWDOWN PROTECTION: portfolio at ${dd.pnlPct.toFixed(1)}% — blocking new ${mode} entries`);
    return false;
  }
  if (!(await checkAllocationCap(config, positionSize, ticker, positions, mode))) return false;
  if (!(await checkSectorExposure(config, ticker, positionSize))) return false;
  if (!(await checkEarningsBlackout(config, ticker))) return false;
  return true;
}

/** Parse "1:x" risk/reward string; returns reward multiple or null. */
function parseRiskReward(rr: string | null | undefined): number | null {
  if (!rr || typeof rr !== 'string') return null;
  const m = rr.trim().match(/\d+(?:\.\d+)?\s*:\s*([\d.]+)/);
  if (!m) return null;
  const x = parseFloat(m[1]);
  return Number.isFinite(x) ? x : null;
}

const MIN_DAY_TRADE_RISK_REWARD = 1.5;

/** Map executeScannerTrade result codes → UI status + human reason. */
function scanResultToEval(result: string): { status: ScanEvaluationStatus; reason: string } {
  if (result === 'executed')                    return { status: 'executed',  reason: 'Order placed' };
  if (result === 'skipped:inside_orb')          return { status: 'watching',  reason: 'ORB — waiting for breakout' };
  if (result === 'skipped:outside-market-hours')return { status: 'watching',  reason: 'Outside market hours' };
  if (result.startsWith('skipped:rr_'))         return { status: 'watching',  reason: 'R/R too low at current price' };
  if (result === 'skipped:no_long_to_sell')     return { status: 'blocked',   reason: 'No position to close' };
  if (result === 'skipped:duplicate')           return { status: 'blocked',   reason: 'Already trading this ticker' };
  if (result === 'skipped:same_day_duplicate')  return { status: 'blocked',   reason: 'Already traded today' };
  if (result === 'skipped:recent_loss_cooldown')return { status: 'blocked',   reason: 'Loss cooldown active' };
  if (result === 'skipped:daily_loss_gate')     return { status: 'blocked',   reason: 'Daily loss limit reached' };
  if (result === 'skipped:market_direction_bearish') return { status: 'blocked', reason: 'SPY bearish — market against BUY' };
  if (result === 'skipped:market_direction_bullish') return { status: 'blocked', reason: 'SPY bullish — market against SELL' };
  if (result === 'skipped:swing_chop')          return { status: 'blocked',   reason: 'Market too choppy' };
  if (result === 'skipped:pre_trade_check')     return { status: 'blocked',   reason: 'Pre-trade gate failed' };
  if (result === 'skipped:max_positions')       return { status: 'blocked',   reason: 'Max positions reached' };
  if (result === 'skipped:penny_stock')        return { status: 'blocked',   reason: 'Price below $5 (penny stock)' };
  if (result === 'skipped:illiquid')           return { status: 'blocked',   reason: 'Illiquid — volume too low' };
  if (result === 'skipped:poor_win_rate')     return { status: 'blocked',   reason: 'Poor win rate — chronic loser' };
  if (result === 'skipped:dust_trade')        return { status: 'blocked',   reason: 'Position too small to be profitable' };
  if (result.startsWith('failed:'))             return { status: 'blocked',   reason: 'Order failed — see logs' };
  return { status: 'blocked', reason: result.replace(/^skipped:/, '') };
}

// ── Trade Execution ──────────────────────────────────────

async function executeScannerTrade(
  idea: TradeIdea,
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
): Promise<string> {
  const { ticker, signal, confidence: scannerConf, mode } = idea;

  // Belt-and-suspenders: never place scanner orders outside market hours,
  // regardless of which code path invoked this function.
  // Also block the 9:30–9:34 window — the first candle hasn't formed yet and
  // spreads are widest right at open. The dedicated 9:36 first-candle cron
  // handles first-candle setups; scanner trades shouldn't race it.
  if (!isMarketHoursET() || getETMinutes() < 9 * 60 + 35) return 'skipped:outside-market-hours';

  // ── Liquidity gate ─────────────────────────────────────────────────
  // Block day trades on stocks below $50 or with abnormally low volume
  // (< 0.15x 10-day avg). Data: sub-$50 scanner trades = -$377 on 7 trades
  // (23% WR in $20-50 range). All scanner profit comes from $200+ stocks.
  if (mode === 'DAY_TRADE') {
    if (idea.price < 50) {
      log(`${ticker}: skipped — price $${idea.price.toFixed(2)} below $50 minimum (scanner price floor)`);
      log(`${ticker}: skipped — price floor (not persisted)`);
      return 'skipped:price_floor';
    }
    // Volume gate: only meaningful after 10:00 AM ET — comparing sub-30-min
    // intraday volume to a full-day 10d average will always look "illiquid"
    // at the open (AAPL at 9:41 legitimately shows 0.04× daily avg).
    const nowEtHour = ((new Date().getUTCHours() - 4 + 24) % 24);
    const nowEtMin  = new Date().getUTCMinutes();
    const afterTenAM = nowEtHour > 10 || (nowEtHour === 10 && nowEtMin >= 0);
    if (afterTenAM && idea.volumeVs10dAvg != null && idea.volumeVs10dAvg < 0.15) {
      log(`${ticker}: skipped — volume ${idea.volumeVs10dAvg.toFixed(2)}x avg (< 0.15x, illiquid)`);
      // Don't persist — this is a transient gate result that fires every scan cycle
      // and would flood the activity log. Console log is sufficient.
      return 'skipped:illiquid';
    }
  }

  // SWING_TRADE SELL signals open a short position (bracket order with GTC TIF).
  // Stop/target levels are correctly oriented for shorts (stop above entry, target below).
  // The position management pipeline handles swing shorts the same as longs.

  // Options positions on the same ticker don't block stock day/swing trades —
  // they are different instruments and managed by a separate pipeline.
  if (await hasActiveTrade(ticker, { excludeOptions: true })) return 'skipped:duplicate';

  // ── Same-day re-entry cooldown (DAY_TRADE only — penny has its own session state) ──
  // hasActiveTrade only checks SUBMITTED/FILLED/PARTIAL — once a day trade hits
  // its target or stop (TARGET_HIT / STOPPED / CLOSED) the ticker is "free" again
  // and the scanner will re-enter it the same afternoon. This creates ghost BUY
  // orders that IB rejects (or fills into a second untracked position), polluting
  // the activity log with $0 P&L entries. Confirmed: WOLF re-entered 28 min after
  // TARGET_HIT on 2026-05-14; NVDA re-entered 36 min after TARGET_HIT same day.
  if (mode === 'DAY_TRADE') {
    const todayEt = getETDateString();
    const sb = getSupabase();
    const { count: todayResolvedCount } = await sb
      .from('paper_trades')
      .select('id', { count: 'exact', head: true })
      .eq('ticker', ticker)
      .in('mode', ['DAY_TRADE', 'DAY_PENNY'])
      .not('mode', 'in', '(OPTIONS_PUT,OPTIONS_CALL)')
      .in('status', ['TARGET_HIT', 'STOPPED', 'CLOSED'])
      .gte('opened_at', `${todayEt}T00:00:00Z`);
    if ((todayResolvedCount ?? 0) > 0) {
      log(`${ticker}: DAY_TRADE skipped — already resolved a day trade on this ticker today`);
      persistEvent(ticker, 'skipped', 'Same-day re-entry blocked — day trade already resolved today', {
        action: 'skipped', source: 'scanner', mode, skip_reason: 'same_day_reentry',
      });
      return 'skipped:same_day_reentry';
    }
  }

  // ── Recent-loss cooldown gate ─────────────────────────────────────────
  // Block re-entry on any ticker that lost money in the last N days.
  // Both swing and day trades use 5 days — swing setups change weekly,
  // a 14-day cooldown was too aggressive and blocked valid re-entries.
  {
    const lookbackDays = 5;
    if (await hasRecentLoss(ticker, lookbackDays, { excludeOptions: true })) {
      log(`${ticker}: skipped — recent loss within ${lookbackDays}d cooldown`);
      persistEvent(ticker, 'skipped', `Re-entry blocked — ticker had a loss within ${lookbackDays} days`, {
        action: 'skipped', source: 'scanner', mode, skip_reason: 'recent_loss_cooldown',
      });
      return 'skipped:recent_loss_cooldown';
    }
  }

  // ── Ticker performance gate ──────────────────────────────────────────
  // Block tickers that are chronic losers for us. If we've traded a ticker
  // at least 4 times in the last 30 days and the win rate is below 35%,
  // stop throwing money at it. Focus capital on proven winners instead.
  {
    const perf = await getTickerWinRate(ticker, 30);
    if (perf.total >= 4 && perf.winRate < 0.35) {
      log(`${ticker}: skipped — poor win rate ${(perf.winRate * 100).toFixed(0)}% (${perf.wins}W/${perf.losses}L last 30d)`);
      persistEvent(ticker, 'skipped', `Ticker performance gate: ${(perf.winRate * 100).toFixed(0)}% win rate (${perf.wins}W/${perf.losses}L)`, {
        action: 'skipped', source: 'scanner', mode, skip_reason: 'poor_win_rate',
      });
      return 'skipped:poor_win_rate';
    }
  }

  // ── Daily max-loss gate ───────────────────────────────────────────────
  if (mode === 'DAY_TRADE' && await isDayTradeLossGateActive(config)) {
    log(`${ticker}: day-trade skipped — daily loss gate active`);
    return 'skipped:daily_loss_gate';
  }

  // ── 4H 100 EMA trend filter (Trade by Pat) ──────────────────────────
  // Day trades only. Reject entries where the higher-timeframe trend is against
  // the signal direction. Non-blocking on data failure.
  if (mode === 'DAY_TRADE' && config.trendFilterEnabled) {
    const tf = await checkTrendFilter(ticker, signal as 'BUY' | 'SELL');
    if (!tf.pass) {
      log(`${ticker}: skipped — ${tf.reason}`);
      persistEvent(ticker, 'skipped', `Trend filter: ${tf.reason}`, {
        action: 'skipped', source: 'scanner', mode, skip_reason: 'trend_filter',
        ema100: tf.ema100, slope: tf.slope,
      });
      return 'skipped:trend_filter';
    }
    if (tf.ema100 != null) {
      log(`${ticker}: trend filter passed — ${tf.reason}`);
    }
  }

  // ── SPY market direction gate ────────────────────────────────────────
  // Day trades only. "Context over pattern": don't buy into a selloff or
  // short into a rally. Index ETFs (SPY, QQQ, IWM, DIA) are excluded —
  // gating them by their own direction would be circular.
  // Non-blocking on data failure (fetchSpyChangePct returns null).
  const MARKET_DIRECTION_PCT = 0.5;
  if (mode === 'DAY_TRADE' && !INDEX_ETFS.has(ticker)) {
    const spyPct = await getCachedSpyChangePct();
    if (spyPct !== null) {
      if (signal === 'BUY' && spyPct < -MARKET_DIRECTION_PCT) {
        log(`${ticker}: skipped — market direction against BUY: SPY ${spyPct.toFixed(2)}%`);
        persistEvent(ticker, 'skipped', `Market direction: SPY ${spyPct.toFixed(2)}% against BUY`, {
          action: 'skipped', source: 'scanner', mode, skip_reason: 'market_direction',
          spy_change_pct: spyPct,
        });
        return 'skipped:market_direction_bearish';
      }
      if (signal === 'SELL' && spyPct > MARKET_DIRECTION_PCT) {
        log(`${ticker}: skipped — market direction against SELL: SPY +${spyPct.toFixed(2)}%`);
        persistEvent(ticker, 'skipped', `Market direction: SPY +${spyPct.toFixed(2)}% against SELL`, {
          action: 'skipped', source: 'scanner', mode, skip_reason: 'market_direction',
          spy_change_pct: spyPct,
        });
        return 'skipped:market_direction_bullish';
      }
    }
  }

  // ── ORB (Opening Range Breakout) chop gate ───────────────────────────
  // Day trades only. If the ticker is stuck inside its 15-min opening range,
  // the market is choppy — but check for a VWAP reclaim before blocking.
  // Somesh's rule: one 5-min candle closing above VWAP signals chop is ending.
  // Gate is non-blocking on data failure (isInsideOrb returns false when unavailable).
  // Gate expires after 12 PM ET — the opening range is stale by afternoon.
  // Skip for vwap_confluence — the strategy IS a chop-exit play.
  const etMinutes = getETMinutes();
  const skipOrbGate = idea.tags?.includes('vwap_confluence');
  if (mode === 'DAY_TRADE' && etMinutes < 12 * 60 && !skipOrbGate) {
    const choppy = await isInsideOrb(ticker, signal as 'BUY' | 'SELL');
    if (choppy) {
      const reclaim = await detectVwapReclaim(ticker, signal as 'BUY' | 'SELL');
      if (reclaim.reclaimed) {
        log(`${ticker}: inside ORB but VWAP ${signal === 'BUY' ? 'reclaimed' : 'broke down'} — proceeding (${reclaim.log})`);
        persistEvent(ticker, 'info', `ORB chop overridden by VWAP reclaim: ${reclaim.log}`, {
          action: 'proceeding', source: 'scanner', mode,
          vwap: reclaim.vwap, current_price: reclaim.currentPrice,
        });
      } else {
        log(`${ticker}: inside ORB (choppy), no VWAP reclaim — skipping ${signal} day trade (${reclaim.log})`);
        persistEvent(ticker, 'skipped', `Inside ORB — choppy conditions, no VWAP reclaim`, {
          action: 'skipped', source: 'scanner', mode, skip_reason: 'inside_orb',
        });
        return 'skipped:inside_orb';
      }
    }
  }

  // ── Swing trade quality gates ─────────────────────────────────────────
  // Swing trades bypass the ORB/VWAP/volume gates above (intraday metrics don't apply
  // to multi-day holds). SMB methodology: low volume during consolidation is POSITIVE
  // (rubber band coiling). Volume confirmation is only required on the breakout/entry day,
  // which the FA call already evaluates via the LLM. Scan-day volume is irrelevant.

  // ── VWAP alignment confidence modifier ───────────────────────────────
  // Day trades only, after 10 AM ET. Adds +0.3 confidence when price is
  // near VWAP and the trade direction aligns with institutional flow.
  // Always non-blocking: missing data, pre-10AM, or far-from-VWAP = 0 delta.
  // Skip for vwap_confluence — VWAP is already baked into the strategy's scoring.
  const skipVwapModifier = idea.tags?.includes('vwap_confluence');
  let adjustedConf = scannerConf;
  if (mode === 'DAY_TRADE' && !skipVwapModifier) {
    const etHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours();
    const { delta: vwapDelta, log: vwapLog } = await evaluateVwapAlignment(ticker, signal as 'BUY' | 'SELL', etHour);
    if (vwapDelta !== 0) {
      adjustedConf = Math.min(10, adjustedConf + vwapDelta);
      log(`${ticker}: VWAP +${vwapDelta} confidence → ${adjustedConf} (${vwapLog})`);
    } else {
      log(`${ticker}: ${vwapLog}`);
    }
  }

  // ── Candlestick pattern confidence modifier ───────────────────────────
  // Applies to scanner-generated day/swing ideas only (not influencer signals,
  // not Suggested Finds, not options). Uses daily bars — no new API calls.
  //
  // Confirming patterns (e.g. bullish engulfing on BUY)  → +0.5 confidence
  // Contradicting patterns (e.g. bearish engulfing on BUY) → -1.0 confidence
  //   If confidence drops below minScannerConfidence, the idea is skipped.
  // Neutral / no pattern detected → no change (non-blocking).
  let candlePatternLog: string[] = [];
  if (mode === 'DAY_TRADE' || mode === 'SWING_TRADE') {
    const candles = await fetchRecentDailyCandles(ticker).catch(() => null);
    if (candles && candles.length >= 3) {
      const result = detectCandlePatterns(candles, signal as 'BUY' | 'SELL');
      candlePatternLog = result.patterns;
      if (result.score > 0) {
        adjustedConf = Math.min(10, adjustedConf + 0.5);
        log(`${ticker}: candle patterns confirm ${signal} — +0.5 confidence → ${adjustedConf} (${result.patterns.join(', ')})`);
      } else if (result.score < 0) {
        adjustedConf = Math.max(0, adjustedConf - 1.0);
        log(`${ticker}: candle patterns contradict ${signal} — -1.0 confidence → ${adjustedConf} (${result.patterns.join(', ')})`);
        if (adjustedConf < config.minScannerConfidence) {
          persistEvent(ticker, 'skipped', `Candle contradiction: ${result.patterns.join(', ')}`, {
            action: 'skipped', source: 'scanner', mode,
            skip_reason: `candle_contradiction: ${result.patterns.join(', ')}`,
          });
          return `skipped:candle_contradiction`;
        }
      } else {
        log(`${ticker}: candle patterns — neutral/no pattern (${result.patterns.join(', ') || 'none'})`);
      }
    }
  }
  // Use adjustedConf from here on (replaces scannerConf in FA threshold checks below)
  const effectiveScannerConf = adjustedConf;

  let entryPrice: number | null;
  let stopLoss: number | null;
  let targetPrice: number | null;
  let targetPrice2: number | null = null;
  let faConf: number;
  let faRec: string;
  let faRiskReward: string | null;

  if ((mode === 'DAY_TRADE' || mode === 'SWING_TRADE') && idea.entryPrice && idea.stopLoss && idea.targetPrice) {
    // Scanner Pass 2 already ran FA — reuse its levels and skip the redundant FA re-call.
    // Day trades: re-anchor tightly (3% tolerance) since intraday price moves fast.
    // Swing trades: re-anchor loosely (6% tolerance) — GTC orders can sit at a level for days.
    const livePrice = await getQuotePrice(ticker).catch(() => null);
    const scannerEntry = idea.entryPrice;
    const staleTolerance = mode === 'SWING_TRADE' ? 0.06 : 0.03;

    const r2 = (n: number) => parseFloat(n.toFixed(2));
    if (livePrice && Math.abs(livePrice - scannerEntry) / scannerEntry <= staleTolerance) {
      // Price moved within tolerance — shift stop/target by the same delta to preserve R:R
      const delta = livePrice - scannerEntry;
      entryPrice = r2(livePrice);
      stopLoss = r2(idea.stopLoss + delta);
      targetPrice = r2(idea.targetPrice + delta);
      // Enforce minimum stop distance: at least 0.8% of price.
      // Tiny stops (< 0.5%) almost always get hit on normal open volatility —
      // they produce huge share counts via risk-sizing and then gap through on fast markets.
      const minStopDist = livePrice * 0.008;
      const actualStopDist = Math.abs(entryPrice - stopLoss);
      if (actualStopDist < minStopDist) {
        stopLoss = signal === 'BUY' ? r2(entryPrice - minStopDist) : r2(entryPrice + minStopDist);
        targetPrice = signal === 'BUY' ? r2(entryPrice + minStopDist * 2) : r2(entryPrice - minStopDist * 2);
        log(`${ticker}: stop too tight (${actualStopDist.toFixed(2)}) — widened to min 0.8% (${minStopDist.toFixed(2)})`);
      }
      log(`${ticker}: [${mode}] live price ${livePrice} (shifted ${delta > 0 ? '+' : ''}${delta.toFixed(2)} from scan entry ${scannerEntry})`);
    } else if (livePrice && idea.atr && idea.atr > 0) {
      // Price moved beyond tolerance — levels are stale. Recompute from ATR around live price.
      const stopDist = idea.atr * 1.0;
      const targetDist = idea.atr * 2.0;
      entryPrice = r2(livePrice);
      stopLoss   = signal === 'BUY' ? r2(livePrice - stopDist) : r2(livePrice + stopDist);
      targetPrice = signal === 'BUY' ? r2(livePrice + targetDist) : r2(livePrice - targetDist);
      log(`${ticker}: [${mode}] price moved >${(staleTolerance * 100).toFixed(0)}% since scan — ATR-reanchored: entry=${entryPrice}, stop=${stopLoss}, target=${targetPrice}`);
    } else {
      // No live price available — use scanner levels as-is
      entryPrice = idea.entryPrice;
      stopLoss = idea.stopLoss;
      targetPrice = idea.targetPrice;
    }
    // Carry T2 from scanner if available (swing partial exit)
    targetPrice2 = idea.targetPrice2 ?? null;

    faConf = effectiveScannerConf; // Pass 2 confidence adjusted by candle modifier
    faRec = signal;       // Signal already reflects FA direction from Pass 2
    faRiskReward = idea.riskReward ?? null;
  } else {
    // Day trades without pre-set levels or swing trades whose scan levels are missing: fresh FA call
    let fa: TradingSignalsResponse;
    try {
      const faMode = mode === 'DAY_TRADE' ? 'DAY_TRADE' : 'SWING_TRADE';
      fa = await fetchTradingSignal(ticker, faMode);
    } catch (err) {
      log(`${ticker}: FA failed — ${err instanceof Error ? err.message : 'unknown'}`);
      return 'failed:fa';
    }
    faConf = fa.trade.confidence;
    faRec = fa.trade.recommendation;
    entryPrice = fa.trade.entryPrice;
    stopLoss = fa.trade.stopLoss;
    targetPrice = fa.trade.targetPrice;
    targetPrice2 = fa.trade.targetPrice2 ?? null;
    faRiskReward = fa.trade.riskReward;
  }

  // Swings with pre-set scanner levels use scanner confidence — use the lower swing threshold.
  // Swings without levels (fresh FA call) and day trades use minFAConfidence.
  const confThreshold = mode === 'SWING_TRADE' ? config.minSwingScannerConfidence : config.minFAConfidence;
  if (faConf < confThreshold) return `skipped:fa_conf_${faConf}`;
  if (faRec === 'HOLD') return 'skipped:fa_hold';
  if (faRec !== signal) return `skipped:direction_mismatch`;

  if (!entryPrice || !stopLoss || !targetPrice) return 'skipped:missing_levels';

  // Day trade: require min 1:1.8 risk/reward
  if (mode === 'DAY_TRADE') {
    const rr = parseRiskReward(faRiskReward);
    if (rr == null || rr < MIN_DAY_TRADE_RISK_REWARD) {
      return `skipped:rr_${rr?.toFixed(1) ?? 'null'}_min_${MIN_DAY_TRADE_RISK_REWARD}`;
    }
  }

  // Swing trade: hard minimum R:R floor of 1.5:1.
  // The prompt says "3:1 minimum" but the code never enforced it — LLMs occasionally
  // return high-confidence, low-R:R setups that execute unfiltered. Compute R:R from actual
  // price levels as a fallback when the string parse fails.
  const MIN_SWING_RISK_REWARD = 1.5;
  if (mode === 'SWING_TRADE' && entryPrice && stopLoss && targetPrice) {
    const risk = Math.abs(entryPrice - stopLoss);
    const reward = Math.abs(targetPrice - entryPrice);
    const rrParsed = parseRiskReward(faRiskReward);
    const effectiveRr = rrParsed ?? (risk > 0 ? reward / risk : 0);
    if (effectiveRr < MIN_SWING_RISK_REWARD) {
      log(`${ticker}: swing skipped — R:R ${effectiveRr.toFixed(2)} below min ${MIN_SWING_RISK_REWARD} (entry=${entryPrice}, stop=${stopLoss}, target=${targetPrice})`);
      return `skipped:rr_${effectiveRr.toFixed(1)}_min_${MIN_SWING_RISK_REWARD}`;
    }
  }

  const dd = assessDrawdownMultiplier(positions);
  const kellyMult = await calculateKellyMultiplier(config);
  const vixMult = await getVixRegimeMultiplier();

  // High-impact economic event days (FOMC, CPI, NFP, etc.) → halve position size.
  // These days produce outsized volatility that wrecks directional day trades.
  const econProfile = mode === 'DAY_TRADE' ? await getEconDayProfile() : null;
  const econMult = econProfile?.positionSizeMultiplier ?? 1.0;
  if (econProfile?.isHighImpact && econMult < 1.0) {
    log(`${ticker}: high-impact econ day — position size ×${econMult} (${econProfile.events.map(e => e.event).join(', ')})`);
  }

  const streakMult = await getStreakMultiplier(mode);
  if (streakMult < 1.0) log(`${ticker}: cold streak active for ${mode} — sizing ×${streakMult}`);

  const sizingRaw = calculatePositionSize(config, {
    price: entryPrice, mode, entryPrice, stopLoss,
    drawdownMultiplier: dd.multiplier * kellyMult * vixMult * econMult,
    streakMultiplier: streakMult,
  });
  // Scanner trades (AI-generated, not expert-vetted) must be capped per mode.
  // Swing trades use a separate, larger cap (swingPositionSize, default $5K) because
  // they're multi-day holds that need meaningful size to generate income. Day trades
  // use positionSize ($1K default) since intraday stops are tighter and gap risk is higher.
  //
  // Confidence-based sizing: high-confidence BUY signals get larger positions.
  // Data (430 trades): conf 9 multiplied trades were net +$1,102 (+$985 vs $5K cap).
  const baseCap = mode === 'SWING_TRADE'
    ? (config.swingPositionSize > 0 ? config.swingPositionSize : 5000)
    : (config.positionSize > 0 ? config.positionSize : 5000);
  const confMultiplier = (signal === 'BUY' && scannerConf >= 9) ? 2.0
    : (signal === 'BUY' && scannerConf >= 8) ? 1.5
    : 1.0;
  const scannerPositionCap = baseCap * confMultiplier;
  if (confMultiplier > 1.0) {
    log(`${ticker}: confidence sizing — conf ${scannerConf} ${signal} → ${confMultiplier}x cap ($${scannerPositionCap.toFixed(0)})`);
  }

  // SPY regime multiplier for swing BUY: reduce size in bearish macro conditions.
  // SELL signals (closing longs or shorts) benefit from bearish markets — no reduction.
  // Non-blocking: defaults to 1.0 on any data failure.
  let spyRegimeMult = 1.0;
  if (mode === 'SWING_TRADE' && signal === 'BUY') {
    try {
      const spyBars = await fetchYahooDailyBars('SPY');
      if (spyBars && spyBars.closes.length >= 200) {
        const closes = spyBars.closes;
        const price = closes[closes.length - 1];
        const sma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
        const sma200 = closes.slice(-200).reduce((a, b) => a + b, 0) / 200;
        if (price < sma200) {
          spyRegimeMult = 0.4;
          log(`${ticker}: SPY below SMA200 — swing BUY size ×0.4 (bearish regime)`);
        } else if (price < sma50) {
          spyRegimeMult = 0.6;
          log(`${ticker}: SPY below SMA50 — swing BUY size ×0.6 (mixed regime)`);
        }
      }
    } catch { /* non-blocking */ }
  }

  const cappedDollarSize = Math.min(sizingRaw.dollarSize, scannerPositionCap) * spyRegimeMult;
  const sizing = {
    dollarSize: cappedDollarSize,
    quantity: Math.max(1, Math.floor(cappedDollarSize / entryPrice)),
  };
  if (sizing.quantity < 1) return 'skipped:size_too_small';

  // ── Dust trade filter ──────────────────────────────────────────────
  // If the expected profit at target is less than $10, the trade isn't
  // worth the execution risk and commissions. Skip it.
  if (targetPrice && entryPrice) {
    const expectedPnl = Math.abs(targetPrice - entryPrice) * sizing.quantity;
    if (expectedPnl < 10) {
      log(`${ticker}: skipped — expected PnL $${expectedPnl.toFixed(2)} < $10 (dust trade)`);
      return 'skipped:dust_trade';
    }
  }

  if (!(await runPreTradeChecks(config, ticker, sizing.dollarSize, positions, mode))) {
    return 'skipped:pre_trade_check';
  }

  // ── Pure order sanity check (synchronous, no DB) ─────────────────────
  {
    const deployed = await getTotalDeployed(positions);
    const orderCheck = validateOrder({
      symbol: ticker,
      side: signal as 'BUY' | 'SELL',
      quantity: sizing.quantity,
      dollarSize: sizing.dollarSize,
      portfolioValue: config.portfolioValue,
      maxPositionPct: config.maxPositionPct,
      deployedCapital: deployed,
      maxTotalAllocation: config.maxTotalAllocation,
    });
    if (!orderCheck.valid) {
      log(`${ticker}: order validation failed [${orderCheck.code}] — ${orderCheck.reason}`);
      return `skipped:validate_order_${orderCheck.code.toLowerCase()}`;
    }
    log(`${ticker}: order validation OK — ${orderCheck.reason}`);
  }

  // Resolve connections via mode router (paper/live/both based on config.modeRouting)
  let connections: RoutedConnection[];
  try {
    connections = getConnectionForMode(mode, config).connections;
  } catch (routeErr) {
    log(`${ticker}: routing failed — ${routeErr instanceof Error ? routeErr.message : 'unknown'}`);
    return 'failed:routing';
  }

  // SWING only: skip if price too far from entry (entry precision matters)
  if (mode === 'SWING_TRADE' && entryPrice > 0) {
    const currentPrice = await getQuotePrice(ticker);
    if (currentPrice != null) {
      const distPct = Math.abs(currentPrice - entryPrice) / entryPrice;
      if (distPct > 0.04) {
        log(`${ticker}: Entry skipped — price too far from entry level (${(distPct * 100).toFixed(1)}% away)`);
        upsertSwingMetrics({ date: getETDateString(), swing_skipped_distance: 1 }).catch(() => {});
        return 'skipped:price_too_far';
      }
    }
  }

  // ── Partial exit split (SWING_TRADE only) ────────────────────────────
  // If FA returned a stretch target (T2) and we have enough shares to split,
  // place TWO independent GTC brackets each for half the quantity:
  //   Bracket 1 — TP at T1 (targetPrice): locks in first 50% profit
  //   Bracket 2 — TP at T2 (targetPrice2): lets the other 50% run
  // Both start with the same stop-loss. This gives natural partial exit
  // without needing IB order modification. Each bracket is an independent
  // paper_trade row so P&L tracking is clean.
  const usePartialExit = mode === 'SWING_TRADE' && targetPrice2 != null && sizing.quantity >= 4;
  const t1Qty = usePartialExit ? Math.floor(sizing.quantity / 2) : sizing.quantity;
  const t2Qty = usePartialExit ? sizing.quantity - t1Qty : 0;
  if (usePartialExit) {
    log(`${ticker}: split bracket — T1 ${t1Qty} @ $${targetPrice}, T2 ${t2Qty} @ $${targetPrice2}`);
  }

  const tif = mode === 'DAY_TRADE' ? 'DAY' : 'GTC';

  let primaryResult: string | undefined;
  for (const { connection, accountType } of connections) {
    if (!connection.isConnected()) {
      if (primaryResult) { log(`${ticker}: [${accountType}] connection down — skipping`); continue; }
      return 'failed:no_contract';
    }

    if (accountType === 'live') {
      try { await assertLiveLossLimitNotBreached(config); } catch (limitErr) {
        log(`${ticker}: [${accountType}] ${limitErr instanceof Error ? limitErr.message : 'live loss limit breached'}`);
        if (primaryResult) continue;
        return 'failed:live_loss_limit';
      }
    }

    try {
      // ── T1 bracket (always placed) ──────────────────────────────────────
      const result = await connection.placeBracketOrder({
        symbol: ticker,
        side: signal,
        quantity: t1Qty,
        entryPrice,
        stopLoss,
        takeProfit: targetPrice,
        tif,
      });

      if (result.timedOut) {
        log(`${ticker}: ⚠️ IB ACK timed out — saving as SUBMITTED anyway (order ${result.parentOrderId}); reconciler will verify`);
      }

      await createPaperTrade({
        ticker, mode, signal,
        scanner_confidence: Math.round(effectiveScannerConf),
        fa_confidence: faConf != null ? Math.round(faConf) : null,
        fa_recommendation: faRec,
        entry_price: entryPrice,
        stop_loss: stopLoss,
        target_price: targetPrice,
        target_price2: targetPrice2,
        risk_reward: faRiskReward,
        quantity: t1Qty,
        position_size: (t1Qty / sizing.quantity) * sizing.dollarSize,
        ib_order_id: String(result.parentOrderId),
        ib_tp_order_id: String(result.takeProfitOrderId),
        ib_sl_order_id: String(result.stopLossOrderId),
        status: 'SUBMITTED',
        scanner_reason: usePartialExit ? `${idea.reason} [T1 tranche]` : idea.reason,
        fa_rationale: null,
        in_play_score: idea.in_play_score,
        pass1_confidence: idea.pass1_confidence,
        entry_trigger_type: 'bracket_limit',
        market_condition: idea.market_condition,
      }, accountType);

      if (!primaryResult) recordPendingOrder(sizing.dollarSize);
      log(`${ticker}: T1 BRACKET [${accountType}] — ${signal} ${t1Qty} @ $${entryPrice}, TP=$${targetPrice}, SL=$${stopLoss}`);

      // ── T2 bracket (only when partial exit is active) ───────────────────
      if (usePartialExit && targetPrice2 != null && t2Qty > 0) {
        try {
          const result2 = await connection.placeBracketOrder({
            symbol: ticker,
            side: signal,
            quantity: t2Qty,
            entryPrice,
            stopLoss,
            takeProfit: targetPrice2,
            tif,
          });

          if (result2.timedOut) {
            log(`${ticker}: ⚠️ T2 IB ACK timed out — saving as SUBMITTED anyway (order ${result2.parentOrderId}); reconciler will verify`);
          }

          await createPaperTrade({
            ticker, mode, signal,
            scanner_confidence: Math.round(effectiveScannerConf),
            fa_confidence: faConf != null ? Math.round(faConf) : null,
            fa_recommendation: faRec,
            entry_price: entryPrice,
            stop_loss: stopLoss,
            target_price: targetPrice2,
            target_price2: null,
            risk_reward: null,
            quantity: t2Qty,
            position_size: (t2Qty / sizing.quantity) * sizing.dollarSize,
            ib_order_id: String(result2.parentOrderId),
            ib_tp_order_id: String(result2.takeProfitOrderId),
            ib_sl_order_id: String(result2.stopLossOrderId),
            status: 'SUBMITTED',
            scanner_reason: `${idea.reason} [T2 tranche]`,
            fa_rationale: null,
            in_play_score: idea.in_play_score,
            pass1_confidence: idea.pass1_confidence,
            entry_trigger_type: 'bracket_limit',
            market_condition: idea.market_condition,
          }, accountType);

          log(`${ticker}: T2 BRACKET [${accountType}] — ${signal} ${t2Qty} @ $${entryPrice}, TP=$${targetPrice2}, SL=$${stopLoss}`);
        } catch (t2Err) {
          // T2 failure is non-fatal — T1 is already placed and tracking the full stop
          log(`${ticker}: T2 bracket FAILED (non-fatal) — ${t2Err instanceof Error ? t2Err.message : 'unknown'}`);
        }
      }

      if (mode === 'SWING_TRADE') {
        upsertSwingMetrics({ date: getETDateString(), swing_orders_placed: 1 }).catch(() => {});
      }
      persistEvent(ticker, 'success', `Order placed: ${signal} ${sizing.quantity} @ $${entryPrice}${usePartialExit ? ` (T1=$${targetPrice}, T2=$${targetPrice2})` : ''}`, {
        action: 'executed', source: 'scanner', mode,
        scanner_signal: signal, scanner_confidence: Math.round(effectiveScannerConf),
        fa_recommendation: faRec, fa_confidence: faConf != null ? Math.round(faConf) : null,
        ...(candlePatternLog.length > 0 && { metadata: { candle_patterns: candlePatternLog } }),
      }, accountType);
      if (!primaryResult) primaryResult = 'executed';
    } catch (err) {
      log(`${ticker}: [${accountType}] Order FAILED — ${err instanceof Error ? err.message : 'unknown'}`);
      if (!primaryResult) primaryResult = 'failed:order';
    }
  }
  return primaryResult ?? 'failed:no_connections';
}

// In-memory set to prevent same-session duplicate SF orders (guards against race conditions
// where two scheduler cycles overlap before the first DB write commits).
const _sfInFlight = new Set<string>();

async function executeSuggestedFindTrade(
  stock: SuggestedStock,
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
): Promise<string> {
  const { ticker, conviction } = stock;

  // Race-condition guard: claim the ticker before any await so a concurrent call sees it.
  if (_sfInFlight.has(ticker)) return 'skipped:in_flight';
  _sfInFlight.add(ticker);

  try {
    return await _executeSuggestedFindTradeInner(stock, config, positions);
  } finally {
    // Release after a short window — same ticker can be re-evaluated next scheduler cycle.
    setTimeout(() => _sfInFlight.delete(ticker), 5 * 60 * 1000);
  }
}

async function _executeSuggestedFindTradeInner(
  stock: SuggestedStock,
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
): Promise<string> {
  const { ticker, conviction } = stock;

  // ── Leveraged/inverse ETF blocklist ──────────────────────────────────
  // These instruments have daily volatility reset and compounding decay that
  // make them structurally incompatible with a quality long-term hold strategy.
  // High IV makes them attractive to the AI screener but unsuitable for the wheel.
  const LEVERAGED_ETF_BLOCKLIST = new Set([
    'SOXL', 'SOXS', 'TQQQ', 'SQQQ', 'SPXL', 'SPXU', 'UVXY', 'SVXY',
    'LABU', 'LABD', 'NUGT', 'DUST', 'JNUG', 'JDST', 'FAS', 'FAZ',
    'TNA', 'TZA', 'NAIL', 'DRN', 'DRV', 'DFEN', 'WEBL', 'WEBS',
  ]);
  if (LEVERAGED_ETF_BLOCKLIST.has(ticker.toUpperCase())) {
    log(`${ticker}: LONG_TERM skipped — leveraged/inverse ETF not suitable for wheel strategy`);
    return 'skipped:leveraged_etf';
  }

  // Hard minimum: never place Suggested Find orders before 9:30 AM ET (belt-and-suspenders).
  // preGenerateSuggestedFinds already checks isMarketHoursET(), but this catches any edge case
  // where that check runs at the boundary (e.g. slow event loop crossing the 9:30 threshold).
  if (!isMarketHoursET()) return 'skipped:outside-market-hours';

  // Resolve account routing for LONG_TERM mode
  let connections: RoutedConnection[];
  try {
    connections = getConnectionForMode('LONG_TERM', config).connections;
  } catch (routeErr) {
    log(`${ticker}: LONG_TERM route error — ${routeErr instanceof Error ? routeErr.message : routeErr}`);
    return 'failed:route_error';
  }
  const accountType = connections[0].accountType;

  if (await hasActiveTrade(ticker, { excludeOptions: true, accountType })) return 'skipped:duplicate';

  if (await hasRecentLoss(ticker, 21, { excludeOptions: true })) {
    log(`${ticker}: LONG_TERM skipped — recent loss within 21d cooldown`);
    persistEvent(ticker, 'skipped', `LONG_TERM re-entry blocked — ticker had a loss within 21 days`, {
      action: 'skipped', source: 'suggested_finds', mode: 'LONG_TERM',
      skip_reason: 'recent_loss_cooldown',
    }, accountType);
    return 'skipped:recent_loss_cooldown';
  }

  {
    const stopOuts = await countRecentStopOuts(ticker, 90, { excludeOptions: true });
    if (stopOuts >= 3) {
      log(`${ticker}: LONG_TERM skipped — ${stopOuts} stop-outs in last 90 days (thesis invalidated)`);
      persistEvent(ticker, 'skipped', `LONG_TERM re-entry blocked — ${stopOuts} stop-outs in 90d`, {
        action: 'skipped', source: 'suggested_finds', mode: 'LONG_TERM',
        skip_reason: 'repeated_stop_out',
      }, accountType);
      return 'skipped:repeated_stop_out';
    }
  }

  {
    const todayEt = getETDateString();
    const sb = getSupabase();
    const { data: todayTrades } = await sb
      .from(tradesTable(accountType))
      .select('id')
      .eq('ticker', ticker)
      .eq('mode', 'LONG_TERM')
      .gte('opened_at', `${todayEt}T00:00:00Z`)
      .limit(1);
    if (todayTrades && todayTrades.length > 0) return 'skipped:same_day_duplicate';
  }

  // Regime gate — Steady Compounders: SKIP entirely in a bear market (SPY < SMA200).
  // Buying long-term holds into a downtrend catches falling knives and produces the
  // worst outcomes. Only accumulate compounders when the macro trend is intact.
  // Dip Discovery is EXEMPT — we explicitly want to buy quality stocks at deep discounts,
  // which often happens during broad market downturns.
  if (stock.tag === 'Steady Compounder') {
    const bearMarket = await isSpyBelowSma200();
    if (bearMarket) {
      log(`${ticker}: Steady Compounder — SPY below SMA200 (bear market), skipping`);
      persistEvent(ticker, 'warning', `Steady Compounder skipped — bear market (SPY < SMA200)`, {
        action: 'skipped', source: 'suggested_finds', mode: 'LONG_TERM',
        skip_reason: 'bear_market_gate',
      });
      return 'skipped:bear_market';
    }
  }

  // Dip Discovery: max 3 concurrent positions, max 1 per GICS sector
  if (stock.tag === 'Dip Discovery') {
    const { dipDiscoveryCount, dipDiscoverySectors } = await getLongTermExposureByTag();
    if (dipDiscoveryCount >= 3) {
      log(`${ticker}: Dip Discovery — already at max 3 concurrent positions, skipping`);
      return 'skipped:dip_discovery_cap';
    }
    const sector = stock.sector ?? 'Unknown';
    if (sector !== 'Unknown' && dipDiscoverySectors.has(sector)) {
      log(`${ticker}: Dip Discovery — already have a position in ${sector} sector, skipping`);
      return 'skipped:dip_discovery_sector_cap';
    }
  }

  // Macro regime: reduce Gold Mine size when SPY < SMA200 — don't block entirely.
  // Geopolitical selloffs are when defense/energy Gold Mines outperform.
  const goldMineBelowSma200 = stock.tag === 'Gold Mine' && await isSpyBelowSma200();

  // FA direction + conviction-drop check before buying.
  // SELL recommendation always blocks. For Steady Compounders, a ≥5-point
  // conviction drop since caching also blocks — thesis may have deteriorated.
  // Gold Mines are news/event driven; FA can't second-guess them, so only SELL veto applies.
  try {
    const fa = await fetchTradingSignal(ticker, 'SWING_TRADE');
    const faRec = fa.trade?.recommendation;
    const faConf = fa.trade?.confidence ?? 0;
    const convDrop = conviction - faConf;

    if (faRec === 'SELL') {
      log(`${ticker}: FA says SELL — skipping Suggested Find`);
      persistEvent(ticker, 'warning', `FA direction veto: SELL — skipping ${stock.tag}`, {
        action: 'skipped', source: 'suggested_finds', mode: 'LONG_TERM',
        scanner_signal: 'BUY', scanner_confidence: conviction,
        fa_recommendation: 'SELL', fa_confidence: faConf,
        skip_reason: 'FA says SELL',
      });
      return 'skipped:fa_sell';
    }

    if (stock.tag === 'Steady Compounder' && convDrop >= 5) {
      const msg = `Conviction dropped ${convDrop} pts (cached: ${conviction} → fresh: ${faConf}) — skipping Steady Compounder`;
      log(`${ticker}: ${msg}`);
      persistEvent(ticker, 'warning', msg, {
        action: 'skipped', source: 'suggested_finds', mode: 'LONG_TERM',
        scanner_signal: 'BUY', scanner_confidence: conviction,
        fa_recommendation: faRec ?? 'HOLD', fa_confidence: faConf,
        skip_reason: `Conviction drop ${convDrop} pts`,
      });
      return 'skipped:conviction_drop';
    }
  } catch {
    // FA check failure is non-blocking — proceed with cached conviction
    log(`${ticker}: FA check failed (non-blocking) — using cached conviction ${conviction}`);
  }

  const currentPrice = await getQuotePrice(ticker);
  if (!currentPrice) return 'failed:no_price';

  const dd = assessDrawdownMultiplier(positions);
  // Kelly NOT applied to long-term: conviction-based sizing already scales with signal quality,
  // and the Kelly multiplier is derived from day/swing history — different risk profile.
  // Drawdown multiplier NOT applied to long-term: critical drawdown (multiplier=0) would zero
  // out the position and result in buying just 1 share. Long-term buys deploy idle cash into
  // a thesis held for months — short-term day/swing drawdown shouldn't shrink them.
  // SPY < SMA200 → buy Gold Mines at 50% size rather than blocking entirely.
  const sma200Multiplier = goldMineBelowSma200 ? 0.5 : 1.0;
  if (goldMineBelowSma200) log(`${ticker}: Gold Mine — SPY below SMA200, buying at 50% size`);
  const sizing = calculatePositionSize(config, {
    price: currentPrice, mode: 'LONG_TERM', conviction,
    suggestedFindTag: (stock.tag === 'Gold Mine' || stock.tag === 'Steady Compounder' || stock.tag === 'Dip Discovery') ? stock.tag as 'Gold Mine' | 'Steady Compounder' | 'Dip Discovery' : undefined,
    regimeMultiplier: sma200Multiplier,
    drawdownMultiplier: 1.0,
  });

  // Tag-level cap: Gold Mine cannot exceed 40% of LONG_TERM sleeve
  if (stock.tag === 'Gold Mine') {
    const { totalGoldMineExposure } = await getLongTermExposureByTag();
    const goldMineCap = config.maxTotalAllocation * 0.40;
    if (totalGoldMineExposure + sizing.dollarSize > goldMineCap) {
      log(`${ticker}: Gold Mine cap — $${totalGoldMineExposure.toFixed(0)} + $${sizing.dollarSize.toFixed(0)} > $${goldMineCap.toFixed(0)} (40%)`);
      return 'skipped:gold_mine_cap';
    }
  }

  if (!(await runPreTradeChecks(config, ticker, sizing.dollarSize, positions, 'LONG_TERM'))) {
    return 'skipped:pre_trade_check';
  }

  let primaryResult: string | undefined;
  for (const { connection, accountType: acctType } of connections) {
    if (!connection.isConnected()) {
      if (primaryResult) { log(`${ticker}: [${acctType}] connection down — skipping`); continue; }
      return 'failed:no_contract';
    }

    if (acctType === 'live') {
      try { await assertLiveLossLimitNotBreached(config); } catch (limitErr) {
        log(`${ticker}: [${acctType}] LONG_TERM live loss limit hit — ${limitErr instanceof Error ? limitErr.message : limitErr}`);
        if (primaryResult) continue;
        return 'failed:live_loss_limit';
      }
    }

    try {
      const result = await connection.placeMarketOrder({
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
        notes: [
          'Long-term hold',
          stock.tag,
          stock.archetype ? `Archetype: ${stock.archetype}` : null,
          `Conviction: ${conviction}/10`,
          stock.valuationTag,
          stock.tag === 'Dip Discovery' && stock.high52w ? `52wHigh: ${stock.high52w.toFixed(2)}` : null,
          stock.tag === 'Dip Discovery' && stock.drawdownPct ? `Drawdown: ${stock.drawdownPct.toFixed(1)}%` : null,
          stock.tag === 'Dip Discovery' && stock.sector ? `Sector: ${stock.sector}` : null,
        ].filter(Boolean).join(' | '),
        entry_trigger_type: 'market',
      }, acctType);

      if (!primaryResult) recordPendingOrder(sizing.dollarSize);
      log(`${ticker}: SUGGESTED FIND BUY [${acctType}] — ${sizing.quantity} shares @ ~$${currentPrice.toFixed(2)}`);
      persistEvent(ticker, 'success', `Suggested Find BUY: ${sizing.quantity} shares @ $${currentPrice.toFixed(2)}`, {
        action: 'executed', source: 'suggested_finds', mode: 'LONG_TERM',
      }, acctType);
      if (!primaryResult) primaryResult = 'executed';
    } catch (err) {
      log(`${ticker}: [${acctType}] Suggested Find order FAILED — ${err instanceof Error ? err.message : 'unknown'}`);
      if (!primaryResult) primaryResult = 'failed:order';
    }
  }
  return primaryResult ?? 'failed:no_connections';
}

/**
 * Returns true if the ticker appears in today's trade_scans results (day or swing).
 * Used to tag external-signal trades that overlap with our own scanner picks.
 */
async function isTickerInTodayScan(ticker: string): Promise<boolean> {
  const sb = getSupabase();
  const { data } = await sb
    .from('trade_scans')
    .select('data')
    .in('id', ['day_trades', 'swing_trades']);
  if (!data) return false;
  const up = ticker.toUpperCase();
  return data.some((row: { data: Array<{ ticker: string }> }) =>
    Array.isArray(row.data) && row.data.some((idea: { ticker: string }) => idea.ticker?.toUpperCase() === up)
  );
}

async function executeExternalStrategySignal(
  signal: ExternalStrategySignal,
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
  options?: {
    allocationSplit?: number;
    allocationIndex?: number;
    allowDuplicateTicker?: boolean;
    /** Skip volume and SPY alignment gates — for manual force-execute */
    skipConfirmationGates?: boolean;
  },
): Promise<'executed' | 'skipped' | 'failed' | 'waiting'> {
  const ticker = signal.ticker.toUpperCase();

  // Resolve account routing
  let extConnections: RoutedConnection[];
  try {
    extConnections = getConnectionForMode(signal.mode, config).connections;
  } catch (routeErr) {
    log(`${ticker}: external signal route error — ${routeErr instanceof Error ? routeErr.message : routeErr}`);
    await updateExternalStrategySignal(signal.id, { status: 'FAILED', failure_reason: `Route error: ${routeErr instanceof Error ? routeErr.message : routeErr}` });
    return 'failed';
  }
  const extAccountType = extConnections[0].accountType;

  if (signal.mode === 'DAY_TRADE' && await isDayTradeLossGateActive(config)) {
    log(`${ticker}: external signal skipped — daily loss gate active`);
    return 'skipped';
  }

  // Check if our own scanner also identified this ticker today.
  const alsoInScanner = await isTickerInTodayScan(ticker);
  // Generic strategy signals use scanner-picked tickers — attribute to scanner, not influencer.
  const isGenericAuto = (signal.notes ?? '').toLowerCase().includes('generic strategy auto');
  const resolvedSource: AutoTradeSource = (isGenericAuto && alsoInScanner) ? 'scanner' : 'external_signal';
  const allocationSplit = Math.max(1, Math.floor(options?.allocationSplit ?? 1));
  const allocationIndex = Math.max(1, Math.floor(options?.allocationIndex ?? 1));
  const allowDuplicateTicker = options?.allowDuplicateTicker === true;
  const skipConfirmationGates = options?.skipConfirmationGates === true;
  const skipExternalSignal = async (failureReason: string, skipReason: string): Promise<'skipped'> => {
    summaryLog(`${ticker}: skipped — ${failureReason}`);
    await updateExternalStrategySignal(signal.id, {
      status: 'SKIPPED',
      failure_reason: failureReason,
    });
    persistEvent(ticker, 'warning', `External signal skipped: ${failureReason}`, {
      action: 'skipped',
      source: resolvedSource,
      mode: signal.mode,
      strategy_source: signal.source_name,
      strategy_source_url: signal.source_url,
      strategy_video_id: signal.strategy_video_id,
      strategy_video_heading: signal.strategy_video_heading,
      skip_reason: skipReason,
    });
    return 'skipped';
  };

  const markX = !skipConfirmationGates ? await shouldMarkStrategyX(signal) : { blocked: false as const, scope: null as null, consecutiveLosses: 0 };
  if (markX.blocked) {
    const reason = `Strategy marked X after ${markX.consecutiveLosses} consecutive losses (${markX.scope})`;
    await updateExternalStrategySignal(signal.id, {
      status: 'SKIPPED',
      failure_reason: reason,
    });
    persistEvent(ticker, 'warning', `External signal skipped: ${reason}`, {
      action: 'skipped',
      source: resolvedSource,
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

  // Generic auto signals may arrive in a later scheduler cycle alone (e.g. after a strategy
  // execution window opens), losing their allocationSplit group context. Always use the lenient
  // conflict check for them so they aren't blocked by a same-direction strategy trade.
  const isGenericAutoSignal = (signal.notes ?? '').toLowerCase().includes('generic strategy auto');
  // Influencer signals (strategy_video_id != null) must never be blocked by a scanner trade
  // on the same ticker — they are fundamentally different signal sources. A scanner trade and
  // an influencer signal for AMD are not duplicates: one is AI-generated, the other is a human
  // expert's specific level. Only block if the SAME video already has an active trade open.
  if (!skipConfirmationGates) {
    if (allowDuplicateTicker || isGenericAutoSignal || signal.strategy_video_id != null) {
      const activeTrades = await getActiveTrades(extAccountType);
      const sameTickerTrades = activeTrades.filter(
        trade => trade.ticker.toUpperCase() === ticker
      );
      const hasConflict = sameTickerTrades.some(trade =>
        trade.mode === signal.mode &&
        trade.signal === signal.signal &&
        trade.strategy_video_id != null &&
        trade.strategy_video_id === signal.strategy_video_id
      );
      if (hasConflict) {
        return skipExternalSignal('Duplicate active trade for ticker', 'duplicate_active_trade_conflict');
      }
    } else if (await hasActiveTrade(ticker, {
      ...(signal.mode !== 'LONG_TERM' ? { excludeMode: 'LONG_TERM' as const } : {}),
      signal: signal.signal,
      excludeOptions: true,
      accountType: extAccountType,
    })) {
      return skipExternalSignal('Duplicate active trade for ticker', 'duplicate_active_trade');
    }

    // Bracket-oversell guard: never execute a SELL external signal when there is an
    // active LONG (BUY) position for the same ticker, and vice versa.
    // The existing IB bracket (STP + LMT) fires at the same price level — placing a
    // second SELL order would oversell and create an accidental short.
    // This mirrors the CSCO/AMAT scenario from May 15 2026.
    const oppositeSignal = signal.signal === 'SELL' ? 'BUY' : 'SELL';
    const hasOpposingPosition = await hasActiveTrade(ticker, {
      ...(signal.mode !== 'LONG_TERM' ? { excludeMode: 'LONG_TERM' as const } : {}),
      signal: oppositeSignal,
      excludeOptions: true,
      accountType: extAccountType,
    });
    if (hasOpposingPosition) {
      return skipExternalSignal(
        `Active ${oppositeSignal === 'BUY' ? 'LONG' : 'SHORT'} position already open for ${ticker} — ${signal.signal} signal blocked to prevent bracket oversell`,
        'opposing_position_blocks_signal',
      );
    }
  }

  const hasProvidedLevels = (
    signal.entry_price != null &&
    signal.stop_loss != null &&
    signal.target_price != null
  );
  // Signals imported from influencer strategy videos (daily_signal / generic_strategy) are
  // trusted as-is — we're testing the strategy, not second-guessing it with our own FA checks.
  const isInfluencerSignal = signal.strategy_video_id != null;
  const requiresFaValidation = !isInfluencerSignal && !hasProvidedLevels && (
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
      // Day trade: require min 1:1.8 risk/reward for auto-trade
      if (signal.mode === 'DAY_TRADE' && (faConf ?? 0) >= config.minFAConfidence) {
        const rr = parseRiskReward(fa.trade.riskReward);
        if (rr == null || rr < MIN_DAY_TRADE_RISK_REWARD) {
          return skipExternalSignal(`Risk/reward ${rr?.toFixed(1) ?? 'null'} below min 1:${MIN_DAY_TRADE_RISK_REWARD}`, 'fa_risk_reward');
        }
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
  if (effectiveEntryPrice != null && quote == null && !skipConfirmationGates) {
    summaryLog(`${ticker}: waiting — no quote`);
    // Record last-known wait reason so Execute Past Window shows context if signal expires
    await updateExternalStrategySignal(signal.id, {
      failure_reason: 'Waiting: could not fetch live price',
    });
    return 'waiting';
  }

  if (effectiveEntryPrice != null && quote != null && !skipConfirmationGates) {
    // OPTIONS_PUT: entry_price is a breakdown level — trigger when price drops BELOW it
    if (signal.mode === 'OPTIONS_PUT' && quote > effectiveEntryPrice) {
      const reason = `Entry trigger not reached: price $${quote.toFixed(2)} above put breakdown level $${effectiveEntryPrice.toFixed(2)}`;
      summaryLog(`${ticker}: waiting — ${reason}`);
      await updateExternalStrategySignal(signal.id, { failure_reason: reason });
      return 'waiting';
    }
    // OPTIONS_CALL / stock BUY: entry_price is a breakout level — trigger when price rises ABOVE it
    if (signal.mode !== 'OPTIONS_PUT' && signal.signal === 'BUY' && quote < effectiveEntryPrice) {
      const reason = `Entry trigger not reached: price $${quote.toFixed(2)} below ${isInfluencerSignal ? 'influencer' : ''} entry $${effectiveEntryPrice.toFixed(2)}`;
      summaryLog(`${ticker}: waiting — ${reason}`);
      await updateExternalStrategySignal(signal.id, { failure_reason: reason });
      return 'waiting';
    }
    if (signal.signal === 'SELL' && quote > effectiveEntryPrice) {
      const reason = `Entry trigger not reached: price $${quote.toFixed(2)} above ${isInfluencerSignal ? 'influencer' : ''} entry $${effectiveEntryPrice.toFixed(2)}`;
      summaryLog(`${ticker}: waiting — ${reason}`);
      await updateExternalStrategySignal(signal.id, { failure_reason: reason });
      return 'waiting';
    }
  }

  // Confirmation gates for day trades — checks run in order, each can return 'waiting'
  // Skipped when skipConfirmationGates=true (manual force-execute) OR for influencer
  // signals (strategy_video_id set) — influencers provide their own entry criteria so
  // volume/SPY gates should not second-guess them and cause signals to expire unused.
  let spyChangePct: number | null = null;
  if (signal.mode === 'DAY_TRADE' && !skipConfirmationGates && !isInfluencerSignal) {
    // Gate 1: Volume — require above-average intraday pace (30%+ above avg)
    const volRatio = await fetchIntradayVolumeRatio(ticker);
    if (volRatio !== null && volRatio < 1.3) {
      summaryLog(`${ticker}: waiting — volume ${volRatio.toFixed(2)}x (need ≥1.3x)`);
      log(`${ticker}: volume pace ${volRatio.toFixed(2)}x avg — waiting for volume confirmation (need ≥1.3x)`);
      return 'waiting';
    }
    if (volRatio !== null) {
      log(`${ticker}: volume pace ${volRatio.toFixed(2)}x avg — confirmed`);
    }

    // Gate 2: SPY/market alignment — don't fight the tape
    spyChangePct = await fetchSpyChangePct();
    if (spyChangePct !== null) {
      const MARKET_MISALIGN_PCT = 0.4;
      if (signal.signal === 'BUY' && spyChangePct < -MARKET_MISALIGN_PCT) {
        summaryLog(`${ticker}: waiting — SPY ${spyChangePct}% (market vs BUY)`);
        log(`${ticker}: SPY is ${spyChangePct}% — market working against BUY — waiting for alignment`);
        return 'waiting';
      }
      if (signal.signal === 'SELL' && spyChangePct > MARKET_MISALIGN_PCT) {
        summaryLog(`${ticker}: waiting — SPY +${spyChangePct}% (market vs SELL)`);
        log(`${ticker}: SPY is +${spyChangePct}% — market working against SELL — waiting for alignment`);
        return 'waiting';
      }
      log(`${ticker}: SPY ${spyChangePct >= 0 ? '+' : ''}${spyChangePct}% — market aligned`);
    }
  } else if (signal.mode === 'DAY_TRADE') {
    spyChangePct = await fetchSpyChangePct().catch(() => null);
    const reason = skipConfirmationGates ? 'manual execute' : 'influencer signal';
    log(`${ticker}: ${reason} — skipping volume/SPY gates (SPY: ${spyChangePct != null ? `${spyChangePct >= 0 ? '+' : ''}${spyChangePct}%` : 'n/a'})`);
  }

  const referencePrice = quote ?? effectiveEntryPrice ?? null;
  if (!referencePrice || referencePrice <= 0) {
    await updateExternalStrategySignal(signal.id, {
      status: 'FAILED',
      failure_reason: 'Unable to resolve market/reference price',
    });
    return 'failed';
  }

  // Influencer penny stock floor: data shows 13 influencer sub-$20 day trades = -$3,469
  // (GFAI at $0.82, EZRA at $0.31, etc.). Block true penny stocks while still allowing
  // influencer calls in the $20-50 range.
  if (isInfluencerSignal && signal.mode === 'DAY_TRADE' && referencePrice < 20) {
    return skipExternalSignal(
      `Price $${referencePrice.toFixed(2)} below $20 influencer day trade floor`,
      'influencer_price_floor',
    );
  }

  const dd = assessDrawdownMultiplier(positions);
  const kellyMult = await calculateKellyMultiplier(config);
  const sizingMultiplier = dd.multiplier * kellyMult;

  // Determine flat dollar size: per-signal override > config flat size > dynamic sizing.
  // When externalSignalPositionSize == 0, sizing falls through to calculatePositionSize()
  // which dynamically scales with base_allocation_pct × maxTotalAllocation.
  const flatDollarSize = signal.position_size_override && signal.position_size_override > 0
    ? signal.position_size_override
    : config.externalSignalPositionSize > 0
      ? config.externalSignalPositionSize
      : null;

  // Influencer signals (from strategy videos) are pre-vetted and have a known track record.
  // Don't let Kelly/drawdown from unrelated scanner trades shrink their position size.
  const isInfluencerSignalForSizing = signal.strategy_video_id != null;

  const extStreakMult = await getStreakMultiplier(signal.mode);
  if (extStreakMult < 1.0) log(`${ticker}: cold streak active for ${signal.mode} — sizing ×${extStreakMult}`);

  const baseSizing = flatDollarSize
    ? (() => {
      const adjusted = isInfluencerSignalForSizing
        ? flatDollarSize
        : flatDollarSize * sizingMultiplier * extStreakMult;
      const quantity = Math.max(1, Math.floor(adjusted / referencePrice));
      return { quantity, dollarSize: quantity * referencePrice };
    })()
    : calculatePositionSize(config, {
      price: referencePrice,
      mode: signal.mode,
      conviction: signal.confidence,
      entryPrice: effectiveEntryPrice ?? undefined,
      stopLoss: effectiveStopLoss ?? undefined,
      drawdownMultiplier: isInfluencerSignalForSizing ? 1.0 : sizingMultiplier,
      streakMultiplier: extStreakMult,
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

  // Influencer signals are pre-vetted — skip drawdown/allocation/sector checks that exist
  // to protect us from our own bad AI trades. Somesh has his own risk management; blocking
  // his signals when our portfolio is red just means we miss his recovery plays.
  if (!skipConfirmationGates && !isInfluencerSignal && !(await runPreTradeChecks(config, ticker, sizing.dollarSize, positions, (signal.mode ?? 'DAY_TRADE') as 'DAY_TRADE' | 'SWING_TRADE'))) {
    await updateExternalStrategySignal(signal.id, {
      status: 'SKIPPED',
      failure_reason: 'Pre-trade risk checks blocked execution',
    });
    persistEvent(ticker, 'warning', 'External signal skipped by risk checks', {
      action: 'skipped',
      source: resolvedSource,
      mode: signal.mode,
      strategy_source: signal.source_name,
      strategy_source_url: signal.source_url,
      skip_reason: 'pre_trade_check',
    });
    return 'skipped';
  }

  const hasBracketLevels = (
    effectiveEntryPrice != null &&
    effectiveStopLoss != null &&
    effectiveTargetPrice != null
  );

  if (
    !skipConfirmationGates &&
    signal.mode === 'SWING_TRADE' &&
    hasBracketLevels &&
    effectiveEntryPrice! > 0 &&
    quote != null
  ) {
    const distPct = Math.abs(quote - effectiveEntryPrice!) / effectiveEntryPrice!;
    if (distPct > 0.04) {
      log(`${ticker}: Entry skipped — price too far from entry level (${(distPct * 100).toFixed(1)}% away)`);
      upsertSwingMetrics({ date: getETDateString(), swing_skipped_distance: 1 }).catch(() => {});
      await updateExternalStrategySignal(signal.id, {
        status: 'SKIPPED',
        failure_reason: `Price ${(distPct * 100).toFixed(1)}% away from entry — entry precision required`,
      });
      return 'skipped';
    }
  }

  {
    const deployed = await getTotalDeployed(positions);
    const orderCheck = validateOrder({
      symbol: ticker,
      side: signal.signal as 'BUY' | 'SELL',
      quantity: sizing.quantity,
      dollarSize: sizing.dollarSize,
      portfolioValue: config.portfolioValue,
      maxPositionPct: config.maxPositionPct,
      deployedCapital: deployed,
      maxTotalAllocation: config.maxTotalAllocation,
    });
    if (!orderCheck.valid) {
      log(`${ticker}: order validation failed [${orderCheck.code}] — ${orderCheck.reason}`);
      return 'skipped';
    }
    log(`${ticker}: order validation OK — ${orderCheck.reason}`);
  }

  // ── OPTIONS path: buy a call or put when signal mode is OPTIONS_CALL/OPTIONS_PUT ──
  if (signal.mode === 'OPTIONS_CALL' || signal.mode === 'OPTIONS_PUT') {
    return executeExternalOptionsSignal(signal, ticker, referencePrice, extConnections, resolvedSource, {
      effectiveEntryPrice,
      effectiveTargetPrice,
      allocationSplit,
      allocationIndex,
    });
  }

  let primaryResult: 'executed' | 'failed' | undefined;
  for (const { connection: extConnection, accountType: acctType } of extConnections) {
    if (!extConnection.isConnected()) {
      if (primaryResult) { log(`${ticker}: [${acctType}] connection down — skipping`); continue; }
      await updateExternalStrategySignal(signal.id, {
        status: 'FAILED',
        failure_reason: 'IB Gateway not connected',
      });
      return 'failed';
    }

    if (acctType === 'live') {
      try { await assertLiveLossLimitNotBreached(config); } catch (limitErr) {
        if (primaryResult) { log(`${ticker}: [${acctType}] live loss limit hit — skipping`); continue; }
        await updateExternalStrategySignal(signal.id, { status: 'FAILED', failure_reason: `Live loss limit: ${limitErr instanceof Error ? limitErr.message : limitErr}` });
        return 'failed';
      }
    }

    try {
      const side = signal.signal;

      let ibOrderId: string;
      const entryForRecord = effectiveEntryPrice ?? referencePrice;
      const splitLabel = allocationSplit > 1
        ? ` | allocation ${allocationIndex}/${allocationSplit}`
        : '';

      let ibTpOrderId: string | undefined;
      let ibSlOrderId: string | undefined;
      if (hasBracketLevels) {
        const result = await extConnection.placeBracketOrder({
          symbol: ticker,
          side,
          quantity: sizing.quantity,
          entryPrice: effectiveEntryPrice!,
          stopLoss: effectiveStopLoss!,
          takeProfit: effectiveTargetPrice!,
          tif: signal.mode === 'DAY_TRADE' ? 'DAY' : 'GTC',
        });
        ibOrderId = String(result.parentOrderId);
        ibTpOrderId = String(result.takeProfitOrderId);
        ibSlOrderId = String(result.stopLossOrderId);
        if (signal.mode === 'SWING_TRADE') {
          upsertSwingMetrics({ date: getETDateString(), swing_orders_placed: 1 }).catch(() => {});
        }
      } else {
        const result = await extConnection.placeMarketOrder({
          symbol: ticker,
          side,
          quantity: sizing.quantity,
        });
        ibOrderId = String(result.orderId);
      }

      const marketCondition: 'trend' | 'chop' | undefined =
        spyChangePct == null ? undefined
        : Math.abs(spyChangePct) >= 0.5 ? 'trend'
        : 'chop';

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
        entry_trigger_type: effectiveEntryPrice != null ? 'bracket_limit' : 'market',
        ib_order_id: ibOrderId,
        ib_tp_order_id: ibTpOrderId ?? null,
        ib_sl_order_id: ibSlOrderId ?? null,
        status: 'SUBMITTED',
        scanner_reason: `External strategy signal from ${signal.source_name}`,
        notes: signal.notes ? `External signal${splitLabel} | ${signal.notes}` : `External signal${splitLabel}`,
        market_condition: marketCondition,
      }, acctType);

      if (!primaryResult) {
        recordPendingOrder(sizing.dollarSize);
        await updateExternalStrategySignal(signal.id, {
          status: 'EXECUTED',
          executed_trade_id: trade.id,
          executed_at: new Date().toISOString(),
          failure_reason: null,
        });
      }

      persistEvent(ticker, 'success', `External signal executed [${acctType}]: ${side} ${sizing.quantity} @ $${entryForRecord.toFixed(2)}`, {
        action: 'executed',
        source: resolvedSource,
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
          entry_time_et: getETTimeString(),
          spy_change_pct: spyChangePct,
          also_in_scanner: alsoInScanner,
        },
      }, acctType);
      if (!primaryResult) primaryResult = 'executed';
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      if (!primaryResult) {
        await updateExternalStrategySignal(signal.id, {
          status: 'FAILED',
          failure_reason: message,
        });
      }
      persistEvent(ticker, 'error', `External signal failed [${acctType}]: ${message}`, {
        action: 'failed',
        source: resolvedSource,
        mode: signal.mode,
        strategy_source: signal.source_name,
        strategy_source_url: signal.source_url,
        strategy_video_id: signal.strategy_video_id,
        strategy_video_heading: signal.strategy_video_heading,
        scanner_signal: signal.signal,
        scanner_confidence: signal.confidence,
        metadata: { external_signal_id: signal.id },
      }, acctType);
      if (!primaryResult) primaryResult = 'failed';
    }
  }
  return primaryResult ?? 'failed';
}

/**
 * Execute an external strategy signal as an options BUY order (long call or long put).
 *
 * Flow:
 *   1. Select strike: ATM or slightly ITM via options chain
 *   2. Select expiry: nearest Friday 10-20 days out
 *   3. Place a limit BUY order for 1 contract at the ask price
 *   4. Record the paper_trade with options metadata
 */
async function executeExternalOptionsSignal(
  signal: ExternalStrategySignal,
  ticker: string,
  stockPrice: number,
  extConnections: RoutedConnection[],
  resolvedSource: AutoTradeSource,
  context: {
    effectiveEntryPrice: number | null;
    effectiveTargetPrice: number | null;
    allocationSplit: number;
    allocationIndex: number;
  },
): Promise<'executed' | 'failed'> {
  const right: 'C' | 'P' = signal.mode === 'OPTIONS_CALL' ? 'C' : 'P';
  const rightLabel = right === 'C' ? 'call' : 'put';
  const splitLabel = context.allocationSplit > 1
    ? ` | allocation ${context.allocationIndex}/${context.allocationSplit}`
    : '';

  log(`${ticker}: OPTIONS ${rightLabel.toUpperCase()} signal — selecting strike/expiry (stock $${stockPrice.toFixed(2)})`);

  // Select strike: for BUY calls, ATM or slightly ITM (strike at/below price).
  // For BUY puts, ATM or slightly ITM (strike at/above price).
  // Use getOptionsChain with a 0.50 delta target (ATM) for directional long options.
  const chain = await getOptionsChain(ticker, stockPrice, null, 0.50, 14).catch((err) => {
    log(`${ticker}: options chain fetch failed — ${err instanceof Error ? err.message : err}`);
    return null;
  });

  let strike: number;
  let expiry: string; // YYYYMMDD
  let limitPrice: number;

  if (right === 'C' && chain?.bestCall) {
    strike = chain.bestCall.strike;
    expiry = chain.bestCall.expiry;
    limitPrice = chain.bestCall.ask > 0 ? chain.bestCall.ask : chain.bestCall.mid;
    log(`${ticker}: chain found — $${strike}C exp ${expiry}, ask $${limitPrice.toFixed(2)}`);
  } else if (right === 'P' && chain?.bestPut) {
    strike = chain.bestPut.strike;
    expiry = chain.bestPut.expiry;
    limitPrice = chain.bestPut.ask > 0 ? chain.bestPut.ask : chain.bestPut.mid;
    log(`${ticker}: chain found — $${strike}P exp ${expiry}, ask $${limitPrice.toFixed(2)}`);
  } else {
    // Fallback: synthesize ATM strike and ~2 week Friday expiry
    const interval = stockPrice < 25 ? 1 : stockPrice < 200 ? 2.5 : 5;
    if (right === 'C') {
      strike = Math.floor(stockPrice / interval) * interval;
    } else {
      strike = Math.ceil(stockPrice / interval) * interval;
    }
    expiry = getNextFridayExpiry(14);
    // Estimate limit using rough 2% of stock price for ATM with ~2 weeks DTE
    limitPrice = stockPrice * 0.025;
    log(`${ticker}: no chain available — using fallback strike $${strike}${right} exp ${expiry}, est. premium $${limitPrice.toFixed(2)}`);
  }

  if (limitPrice <= 0) {
    await updateExternalStrategySignal(signal.id, { status: 'FAILED', failure_reason: 'Options premium is zero or negative' });
    return 'failed';
  }

  const contracts = 1;
  const positionSize = limitPrice * 100 * contracts;

  // Execute on first available connection
  let primaryResult: 'executed' | 'failed' | undefined;
  for (const { connection: extConnection, accountType: acctType } of extConnections) {
    if (!extConnection.isConnected()) {
      if (primaryResult) { log(`${ticker}: [${acctType}] connection down — skipping options`); continue; }
      await updateExternalStrategySignal(signal.id, { status: 'FAILED', failure_reason: 'IB Gateway not connected' });
      return 'failed';
    }

    try {
      const orderResult = await placeOptionsOrder({
        symbol: ticker,
        right,
        strike,
        expiry,
        contracts,
        limitPrice,
        action: 'BUY',
        account: getDefaultAccount() ?? undefined,
      });

      log(`${ticker}: OPTIONS ${rightLabel} order FILLED — IB#${orderResult.orderId}, ${orderResult.filledQty} contracts @ $${orderResult.avgFillPrice.toFixed(2)}`);

      const fillPremium = orderResult.avgFillPrice;
      const expiryISO = `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}`;

      const trade = await createPaperTrade({
        ticker,
        mode: signal.mode,
        signal: 'BUY',
        strategy_source: signal.source_name,
        strategy_source_url: signal.source_url,
        strategy_video_id: signal.strategy_video_id,
        strategy_video_heading: signal.strategy_video_heading,
        scanner_confidence: signal.confidence,
        entry_price: stockPrice,
        fill_price: fillPremium,
        target_price: context.effectiveTargetPrice,
        quantity: contracts,
        position_size: positionSize,
        status: 'FILLED',
        filled_at: new Date().toISOString(),
        opened_at: new Date().toISOString(),
        entry_trigger_type: 'external_options_signal',
        ib_order_id: String(orderResult.orderId),
        option_strike: strike,
        option_expiry: expiryISO,
        option_premium: fillPremium,
        option_contracts: contracts,
        option_capital_req: positionSize,
        scanner_reason: `External options signal from ${signal.source_name}`,
        notes: signal.notes
          ? `External ${rightLabel} signal${splitLabel} | strike $${strike} exp ${expiryISO} | ${signal.notes}`
          : `External ${rightLabel} signal${splitLabel} | strike $${strike} exp ${expiryISO}`,
      }, acctType);

      if (!primaryResult) {
        await updateExternalStrategySignal(signal.id, {
          status: 'EXECUTED',
          executed_trade_id: trade.id,
          executed_at: new Date().toISOString(),
          failure_reason: null,
        });
      }

      persistEvent(ticker, 'success', `External options ${rightLabel} executed [${acctType}]: BUY ${contracts}x $${strike}${right} @ $${fillPremium.toFixed(2)}`, {
        action: 'executed',
        source: resolvedSource,
        mode: signal.mode,
        strategy_source: signal.source_name,
        strategy_source_url: signal.source_url,
        strategy_video_id: signal.strategy_video_id,
        strategy_video_heading: signal.strategy_video_heading,
        metadata: {
          external_signal_id: signal.id,
          strike,
          expiry: expiryISO,
          premium: fillPremium,
          contracts,
          right,
          allocation_split: context.allocationSplit,
          allocation_index: context.allocationIndex,
        },
      }, acctType);
      if (!primaryResult) primaryResult = 'executed';
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      log(`${ticker}: OPTIONS ${rightLabel} order FAILED — ${message}`);
      if (!primaryResult) {
        await updateExternalStrategySignal(signal.id, { status: 'FAILED', failure_reason: message });
      }
      persistEvent(ticker, 'error', `External options ${rightLabel} failed [${acctType}]: ${message}`, {
        action: 'failed',
        source: resolvedSource,
        mode: signal.mode,
        strategy_source: signal.source_name,
        strategy_source_url: signal.source_url,
        strategy_video_id: signal.strategy_video_id,
        strategy_video_heading: signal.strategy_video_heading,
        metadata: { external_signal_id: signal.id, strike, expiry, right },
      }, acctType);
      if (!primaryResult) primaryResult = 'failed';
    }
  }
  return primaryResult ?? 'failed';
}

/** Find the nearest Friday expiry that is at least `minDays` out. */
function getNextFridayExpiry(minDays: number): string {
  const now = new Date();
  const target = new Date(now.getTime() + minDays * 86_400_000);
  // Move to the next Friday (day 5)
  const day = target.getDay();
  const daysUntilFriday = (5 - day + 7) % 7 || 7;
  const friday = new Date(target.getTime() + daysUntilFriday * 86_400_000);
  // If the computed Friday is less than minDays away (can happen when target IS Friday),
  // use the following Friday
  const daysFromNow = Math.ceil((friday.getTime() - now.getTime()) / 86_400_000);
  if (daysFromNow < minDays) {
    friday.setDate(friday.getDate() + 7);
  }
  const y = friday.getFullYear();
  const m = String(friday.getMonth() + 1).padStart(2, '0');
  const d = String(friday.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

async function processExternalStrategySignals(
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
): Promise<void> {
  const pending = await getDueExternalStrategySignals();
  if (pending.length === 0) {
    summaryLog('No pending external signals for today');
    return;
  }
  summaryLog(`Processing ${pending.length} pending external signal(s)`);

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

    // Daily signal influencer trades: group multi-target signals (same video + ticker + mode +
    // direction) and mark allowDuplicateTicker so T2 isn't blocked after T1 executes.
    const dailySignalGroups = new Map<string, ExternalStrategySignal[]>();
    for (const signal of pending) {
      if (!signal.strategy_video_id) continue;
      const key = [
        signal.strategy_video_id,
        signal.ticker.toUpperCase(),
        signal.mode,
        signal.signal,
      ].join('::');
      const list = dailySignalGroups.get(key) ?? [];
      list.push(signal);
      dailySignalGroups.set(key, list);
    }
    for (const group of dailySignalGroups.values()) {
      if (group.length <= 1) continue;
      group.sort((a, b) => a.created_at.localeCompare(b.created_at));
      group.forEach((signal, idx) => {
        if (!executionOptionsBySignalId.has(signal.id)) {
          executionOptionsBySignalId.set(signal.id, {
            allocationSplit: 1,
            allocationIndex: 1,
            allowDuplicateTicker: true,
          });
        } else {
          executionOptionsBySignalId.get(signal.id)!.allowDuplicateTicker = true;
        }
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

  // Prevent same ticker from executing two opposing conditional signals in the same batch
  // (e.g. QQQ BUY above 500 + QQQ SELL below 495 both firing when price is between them).
  const executedTickersThisBatch = new Set<string>();

  for (const signal of pending) {
    const executeAtMs = signal.execute_at ? new Date(signal.execute_at).getTime() : null;
    if (executeAtMs && nowMs < executeAtMs) {
      continue;
    }

    const expiresAtMs = signal.expires_at ? new Date(signal.expires_at).getTime() : null;
    if (expiresAtMs && nowMs > expiresAtMs) {
      // Preserve last-known wait reason (e.g. "Entry trigger not reached: price $X below entry $Y")
      // so Execute Past Window shows why it expired rather than a generic message.
      const expiredReason = signal.failure_reason
        ? `Expired — ${signal.failure_reason}`
        : 'Execution window closed before entry conditions were met';
      await updateExternalStrategySignal(signal.id, {
        status: 'EXPIRED',
        failure_reason: expiredReason,
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

    // ── Price trigger gate ──────────────────────────────────────────────────
    // If the signal has an entry_price, verify the current market price has
    // actually reached (or crossed) that level before executing.
    // BUY signals: execute only if currentPrice >= entry_price (breakout/long above)
    // SELL signals: execute only if currentPrice <= entry_price (short/breakdown below)
    // This prevents both legs of an opposing pair (e.g. QQQ BUY above X + SELL below Y)
    // from simultaneously firing when only one trigger is actually crossed.
    if (signal.entry_price != null) {
      const currentPrice = await getQuotePrice(signal.ticker).catch(() => null);
      if (currentPrice != null) {
        const triggerCrossed = signal.signal === 'BUY'
          ? currentPrice >= signal.entry_price
          : currentPrice <= signal.entry_price;
        if (!triggerCrossed) {
          const direction = signal.signal === 'BUY' ? 'above' : 'below';
          const triggerReason = `Entry trigger not reached: price $${currentPrice.toFixed(2)} not ${direction} entry $${signal.entry_price.toFixed(2)}`;
          log(`${signal.ticker} [${signal.signal}]: ${triggerReason} — skipping this cycle`);
          await updateExternalStrategySignal(signal.id, { failure_reason: triggerReason });
          waiting += 1;
          continue;
        }
      }
    }

    // ── Per-batch ticker dedup ──────────────────────────────────────────────
    // Once a ticker has been executed this batch, skip any other signals for it.
    // Prevents the duplicate-P&L issue where BUY and SELL for the same ticker
    // both execute within the same scheduler cycle.
    const tickerKey = `${signal.ticker.toUpperCase()}`;
    if (executedTickersThisBatch.has(tickerKey)) {
      log(`${signal.ticker}: already executed this cycle — skipping duplicate signal`);
      waiting += 1;
      continue;
    }

    const result = await executeExternalStrategySignal(
      signal,
      config,
      positions,
      executionOptionsBySignalId.get(signal.id),
    );
    if (result === 'executed') {
      executed += 1;
      executedTickersThisBatch.add(tickerKey);
    }
    if (result === 'skipped') skipped += 1;
    if (result === 'failed') failed += 1;
    if (result === 'waiting') waiting += 1;
    await new Promise(r => setTimeout(r, 1500));
  }

  if (executed + skipped + failed + expired + waiting > 0) {
    const extMsg = `External signals — executed:${executed} waiting:${waiting} skipped:${skipped} failed:${failed} expired:${expired}`;
    log(`External signals processed — executed:${executed} waiting:${waiting} skipped:${skipped} failed:${failed} expired:${expired}`);
    summaryLog(extMsg);
  }
}

// ── Position Management (Sync + Dip Buy + Profit Take + Loss Cut) ──

async function syncPositions(
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
): Promise<void> {
  // Sync positions on both paper and live accounts
  for (const syncAcct of ['paper', 'live'] as AccountType[]) {
    const syncConn = getConnectionForAccount(syncAcct);
    if (!syncConn.isConnected()) continue;
    await _syncPositionsForAccount(config, positions, syncAcct);
  }
}

async function _syncPositionsForAccount(
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
  syncAcct: AccountType,
): Promise<void> {
  const activeTrades = await getActiveTrades(syncAcct);

  for (const trade of activeTrades) {
    // Options positions are managed exclusively by options-manager — never touch them here.
    if (trade.mode === 'OPTIONS_PUT' || trade.mode === 'OPTIONS_CALL') continue;

    const ibPos = positions.find(
      p => p.symbol.toUpperCase() === trade.ticker.toUpperCase()
    );

    if (ibPos && ibPos.position !== 0) {
      // Position exists — clear missing_since if it was set (position reappeared)
      if (trade.missing_since) {
        await updatePaperTrade(trade.id, { missing_since: null }, syncAcct);
        log(`${trade.ticker}: Position reappeared — cleared missing_since`);
      }
      if (trade.status === 'SUBMITTED' || trade.status === 'PENDING') {
        if (trade.mode === 'SWING_TRADE' && trade.entry_trigger_type === 'bracket_limit') {
          upsertSwingMetrics({ date: getETDateString(), swing_orders_filled: 1 }).catch(() => {});
        }
        // Priority for fill price:
        // 1. IB orderStatus avgFillPrice — the actual execution price from IB (definitive)
        // 2. entry_price — the limit/stop price we sent to IB (close approximation)
        // 3. avgCost — LAST RESORT only; blended across ALL shares in the position,
        //    so it's wrong when the account holds prior shares of the same ticker
        const ibOrderId = trade.ib_order_id ? parseInt(trade.ib_order_id, 10) : NaN;
        const ibFill = !Number.isNaN(ibOrderId)
          ? (getOrderFillPrice(ibOrderId) ?? await getOrderFillPriceWithFallback(ibOrderId))
          : undefined;
        const fillPrice = ibFill ?? trade.entry_price ?? ibPos.avgCost;
        const updates: Record<string, unknown> = {
          status: 'FILLED',
          fill_price: fillPrice,
          filled_at: new Date().toISOString(),
        };
        // Swing: collect entry log metrics (no automated decisions yet)
        if (trade.mode === 'SWING_TRADE') {
          try {
            const entryLog = await computeSwingEntryLog(trade.ticker, fillPrice);
            if (entryLog.pct_distance_sma20_at_entry != null) {
              updates.pct_distance_sma20_at_entry = entryLog.pct_distance_sma20_at_entry;
            }
            if (entryLog.macd_histogram_slope_at_entry != null) {
              updates.macd_histogram_slope_at_entry = entryLog.macd_histogram_slope_at_entry;
            }
            if (entryLog.volume_vs_10d_avg_at_entry != null) {
              updates.volume_vs_10d_avg_at_entry = entryLog.volume_vs_10d_avg_at_entry;
            }
            if (entryLog.regime_alignment_at_entry != null) {
              updates.regime_alignment_at_entry = entryLog.regime_alignment_at_entry;
            }
          } catch (err) {
            log(`${trade.ticker}: Entry log failed — ${err instanceof Error ? err.message : 'unknown'}`);
          }
        }
        await updatePaperTrade(trade.id, updates, syncAcct);
        log(`${trade.ticker}: Filled @ $${fillPrice.toFixed(2)}`);
      }

      // Unrealized P&L for open trades is computed on-the-fly by the frontend.
      // Do NOT write it to the pnl field — that field is reserved for realized P&L
      // set by recordTradeClose() with a confirmed pnl_source.
    } else if (trade.status === 'FILLED') {
      // Position gone — closed by bracket TP/SL or manual action.
      // 2-cycle guard: don't auto-close on first detection. Set missing_since,
      // wait 30 min (2 sync cycles) before confirming closure.
      const MISSING_GUARD_MS = 30 * 60 * 1000; // 30 minutes

      // Try to get actual exit fill price from IB fills (cache + DB fallback)
      const tpId = trade.ib_tp_order_id ? parseInt(trade.ib_tp_order_id, 10) : NaN;
      const slId = trade.ib_sl_order_id ? parseInt(trade.ib_sl_order_id, 10) : NaN;
      const tpFill = !Number.isNaN(tpId) ? await getOrderFillPriceWithFallback(tpId) : undefined;
      const slFill = !Number.isNaN(slId) ? await getOrderFillPriceWithFallback(slId) : undefined;
      const ibExitFill = tpFill ?? slFill;

      // If we have a confirmed IB exit fill, close immediately (no guard needed)
      const hasConfirmedFill = ibExitFill !== undefined;

      if (!hasConfirmedFill && !trade.missing_since) {
        // First detection — mark as missing, don't close yet
        await updatePaperTrade(trade.id, { missing_since: new Date().toISOString() }, syncAcct);
        log(`${trade.ticker}: Position missing — marking missing_since (will confirm in ~30 min)`);
        continue;
      }

      if (!hasConfirmedFill && trade.missing_since) {
        const missingFor = Date.now() - new Date(trade.missing_since).getTime();
        if (missingFor < MISSING_GUARD_MS) {
          log(`${trade.ticker}: Position still missing (${Math.round(missingFor / 60000)} min) — waiting for guard period`);
          continue;
        }
        log(`${trade.ticker}: Position missing for ${Math.round(missingFor / 60000)} min — proceeding with closure (fallback)`);
      }

      const closePrice = ibExitFill ?? (await getQuotePrice(trade.ticker));
      if (!hasConfirmedFill) {
        log(`[WARN] ${trade.ticker}: Closing with fallback quote price (no IB fill found) — close_price=${closePrice}`);
      }
      const fillPrice = trade.fill_price ?? trade.entry_price ?? 0;
      const qty = trade.quantity ?? 1;
      const isLong = trade.signal === 'BUY';
      const actual = closePrice ?? fillPrice;
      const pnl = isLong
        ? (actual - fillPrice) * qty
        : (fillPrice - actual) * qty;

      let closeReason: import('../../shared/trade-types.js').CloseReason = 'manual';
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

      const status: import('../../shared/trade-types.js').TradeStatus = closeReason === 'stop_loss' ? 'STOPPED'
        : closeReason === 'target_hit' ? 'TARGET_HIT' : 'CLOSED';

      let rMultiple: number | null = null;
      if (trade.stop_loss != null && trade.entry_price != null && trade.entry_price !== trade.stop_loss) {
        const riskPerShare = Math.abs(trade.entry_price - trade.stop_loss);
        rMultiple = isLong
          ? (actual - fillPrice) / riskPerShare
          : (fillPrice - actual) / riskPerShare;
        rMultiple = parseFloat(rMultiple.toFixed(2));
      }

      const pnlSource = hasConfirmedFill ? 'ib_fill_calculated' : (closePrice ? 'quote_fallback' : 'estimated');
      const closedAt = new Date().toISOString();
      const pnlVal = parseFloat(pnl.toFixed(2));
      const pnlPct = fillPrice > 0 ? parseFloat(((pnl / (fillPrice * qty)) * 100).toFixed(2)) : null;
      await recordTradeClose({
        tradeId: trade.id,
        closePrice: actual,
        closeReason,
        status,
        orderId: tpId || slId || undefined,
        accountType: syncAcct,
        overridePnlSource: pnlSource as 'ib_fill_calculated' | 'quote_fallback' | 'estimated',
        extraUpdates: { r_multiple: rMultiple, missing_since: null },
      } as Parameters<typeof recordTradeClose>[0]);
      log(`${trade.ticker}: Closed [${syncAcct}] (${closeReason}) — P&L $${pnl.toFixed(2)}${hasConfirmedFill ? '' : ' [fallback price]'}`);
      const closedTrade = {
        ...trade,
        status,
        close_reason: closeReason,
        close_price: actual,
        closed_at: closedAt,
        pnl: pnlVal,
        pnl_percent: pnlPct,
      };
      analyzeCompletedTrade(closedTrade)
        .then(ok => {
          if (ok) updatePerformancePatterns().catch(() => {});
        })
        .catch(err => log(`Trade analysis failed for ${trade.ticker}: ${err instanceof Error ? err.message : 'unknown'}`));
      if (trade.mode === 'LONG_TERM' && !(trade.notes ?? '').startsWith('Dip buy')) {
        const tradeForLog = {
          ...closedTrade,
          opened_at: trade.opened_at ?? trade.created_at ?? closedAt,
        } as import('./lib/supabase.js').PaperTrade;
        logLongTermPerformance(tradeForLog)
          .catch(err => log(`Performance log failed for ${trade.ticker}: ${err instanceof Error ? err.message : 'unknown'}`));
      }
      logClosedTradePerformance(closedTrade as import('./lib/supabase.js').PaperTrade, {
        source: 'scheduler',
        trigger: hasConfirmedFill ? 'IB_FILL_CONFIRMED' : 'IB_POSITION_GONE_FALLBACK',
      }, syncAcct).catch(err => log(`Trade perf log failed for ${trade.ticker}: ${err instanceof Error ? err.message : 'unknown'}`));
    } else if (trade.status === 'SUBMITTED') {
      // ── Fill detection for SUBMITTED orders ───────────────────────────────
      // Market/limit orders (no bracket) don't get monitored via TP/SL fill lookup.
      // Check ib_fills directly using the entry order ID. If IB recorded a fill,
      // update to FILLED so the position sync can manage it going forward.
      // This catches cases like influencer SELL signals that close long positions —
      // the long position disappears from IB immediately, so position-based detection
      // misses the fill, leaving the paper_trade stuck as SUBMITTED.
      if (trade.ib_order_id && !trade.ib_tp_order_id && !trade.ib_sl_order_id) {
        const orderId = parseInt(trade.ib_order_id, 10);
        if (!Number.isNaN(orderId)) {
          const fill = await getOrderFillPriceWithFallback(orderId);
          if (fill != null) {
            const isSell = trade.signal === 'SELL';
            const qty = trade.quantity ?? 1;
            const fillPrice = fill;

            // For a SELL that closes a long position, we can also try to compute
            // the realized P&L if we know the original long entry.
            // For now just mark as FILLED — the position sync loop will handle the rest.
            await updatePaperTrade(trade.id, {
              status: 'FILLED',
              fill_price: fillPrice,
              filled_at: new Date().toISOString(),
            }, syncAcct);
            log(`${trade.ticker}: SUBMITTED → FILLED (fill detected in ib_fills: orderId=${orderId} @ $${fillPrice})`);

            if (isSell) {
              const originalFillPrice = trade.fill_price ?? trade.entry_price ?? fillPrice;
              const pnl = (fillPrice - originalFillPrice) * qty;
              let closeReason: import('../../shared/trade-types.js').CloseReason = 'manual';
              if (pnl > 0) closeReason = 'target_hit';
              if (pnl < 0) closeReason = 'stop_loss';
              const closedAt = new Date().toISOString();
              await updatePaperTrade(trade.id, {
                status: pnl > 0 ? 'TARGET_HIT' : pnl < 0 ? 'STOPPED' : 'CLOSED',
                close_price: fillPrice,
                close_reason: closeReason,
                pnl: parseFloat(pnl.toFixed(2)),
                pnl_percent: originalFillPrice > 0 ? parseFloat(((pnl / (originalFillPrice * qty)) * 100).toFixed(2)) : null,
                pnl_source: 'ib_fill_calculated',
                closed_at: closedAt,
              }, syncAcct);
              log(`${trade.ticker}: SELL closed immediately — fill @ $${fillPrice}, P&L $${pnl.toFixed(2)}`);
              continue;
            }
          }
        }
      }

      const tradeAge = Date.now() - new Date(trade.created_at).getTime();
      // Stale day trades — expire at market close (4:15 PM ET) if created today,
      // or after 24h as a safety net for any that slip through.
      const tradeDateET = new Date(trade.created_at).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
      const todayET = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
      const dayOrderExpired = (trade.mode === 'DAY_TRADE' || trade.mode === 'DAY_PENNY') && (
        (tradeDateET === todayET && isPastMarketCloseET()) || tradeAge > 86400000
      );
      if (dayOrderExpired) {
        const closedAt = new Date().toISOString();
        await updatePaperTrade(trade.id, {
          status: 'CLOSED', close_reason: 'manual',
          closed_at: closedAt,
          notes: (trade.notes ?? '') + ' | Expired: DAY order not filled by market close',
        }, syncAcct);
        logClosedTradePerformance(
          { ...trade, status: 'CLOSED', close_reason: 'manual', closed_at: closedAt } as import('./lib/supabase.js').PaperTrade,
          { source: 'scheduler', trigger: 'EXPIRED_DAY_ORDER' },
          syncAcct,
        ).catch(() => {});
        log(`${trade.ticker}: Day trade expired (market closed)`);
      }
      // Swing bracket limit: expire after 3 trading days (Mon–Fri, excl. holidays).
      // Previously used 48 calendar hours which silently cancelled orders over weekends
      // before Monday's market open. Now counts actual trading days so GTC limits
      // placed Friday survive to give the setup time to trigger early next week.
      if (
        trade.mode === 'SWING_TRADE' &&
        trade.entry_trigger_type === 'bracket_limit' &&
        countTradingDaysSince(new Date(trade.opened_at)) >= 3
      ) {
        const orderId = trade.ib_order_id ? parseInt(trade.ib_order_id, 10) : NaN;
        if (!Number.isNaN(orderId)) {
          try {
            getConnectionForAccount(syncAcct).cancelOrder(orderId);
            log(`${trade.ticker}: Swing bracket limit cancelled (expired ≥3 trading days unfilled)`);
          } catch (err) {
            log(`${trade.ticker}: Cancel failed — ${err instanceof Error ? err.message : 'unknown'}`);
          }
        }
        upsertSwingMetrics({ date: getETDateString(), swing_orders_expired: 1 }).catch(() => {});
        const closedAt = new Date().toISOString();
        await updatePaperTrade(trade.id, {
          status: 'CLOSED', close_reason: 'manual',
          closed_at: closedAt,
          notes: (trade.notes ?? '') + ' | Expired: SWING limit not filled within 3 trading days',
        }, syncAcct);
        logClosedTradePerformance(
          { ...trade, status: 'CLOSED', close_reason: 'manual', closed_at: closedAt } as import('./lib/supabase.js').PaperTrade,
          { source: 'scheduler', trigger: 'EXPIRED_SWING_BRACKET' },
          syncAcct,
        ).catch(() => {});
      }
    }
  }
}

// ── Compounder Health Check ───────────────────────────────────────────────────

/**
 * Weekly health review for all active Steady Compounder positions.
 *
 * For each position this computes:
 *   - positiveDayRatio  : fraction of trading days since entry that closed above fill price
 *   - healthScore       : 0–10 (10 = always green, 0 = never above entry)
 *   - status            : 'strong' | 'healthy' | 'watch' | 'zombie'
 *
 * Status rules:
 *   zombie  — 0 positive closes after 20+ days held → flag for manual review, dip buys blocked
 *   watch   — positiveDayRatio < 0.30 after 20+ days → accumulate cautiously
 *   healthy — positiveDayRatio ≥ 0.30 OR held < 20 days
 *   strong  — current gain ≥ +5% OR positiveDayRatio ≥ 0.60
 *
 * Results are logged and persisted as an auto_trade_event for the dashboard.
 * Profit-trim recommendations are surfaced for positions at +5% or +10%.
 */
async function runCompoundersHealthCheck(): Promise<void> {
  const activeTrades = await getActiveTrades();
  const compounders = activeTrades.filter(t =>
    t.mode === 'LONG_TERM' &&
    t.status === 'FILLED' &&
    !(/Gold Mine/i.test(`${t.notes ?? ''} ${t.scanner_reason ?? ''}`))
  );

  if (compounders.length === 0) return;
  log(`[HealthCheck] Running weekly Compounder review — ${compounders.length} positions`);

  const lines: string[] = [];

  for (const trade of compounders) {
    const entryPrice = trade.fill_price ?? 0;
    if (entryPrice <= 0) continue;

    const daysHeld = trade.filled_at
      ? (Date.now() - new Date(trade.filled_at).getTime()) / 86400000
      : 0;

    // Fetch recent daily closes via Yahoo Finance
    const bars = await fetchYahooDailyBars(trade.ticker);
    if (!bars) {
      log(`[HealthCheck] ${trade.ticker}: no price data — skipping`);
      continue;
    }

    // Slice to the trading days since fill (cap at available data)
    const daysWindow = Math.min(Math.ceil(daysHeld) + 2, bars.closes.length);
    const closes = bars.closes.slice(-daysWindow);
    const positiveDays = closes.filter(c => c > entryPrice).length;
    const ratio = closes.length > 0 ? positiveDays / closes.length : 0;
    const currentPrice = closes[closes.length - 1] ?? entryPrice;
    const gainPct = ((currentPrice - entryPrice) / entryPrice) * 100;
    const score = Math.round(ratio * 10); // 0–10

    let status: 'strong' | 'healthy' | 'watch' | 'zombie';
    if (positiveDays === 0 && daysHeld >= 20) {
      status = 'zombie';
    } else if (gainPct >= 5 || ratio >= 0.60) {
      status = 'strong';
    } else if (ratio < 0.30 && daysHeld >= 20) {
      status = 'watch';
    } else {
      status = 'healthy';
    }

    // Profit-trim recommendation
    let trimHint = '';
    if (gainPct >= 10) trimHint = ' → TRIM: consider selling 25% (Tier 2 at +10%)';
    else if (gainPct >= 5) trimHint = ' → TRIM: consider selling 25% (Tier 1 at +5%)';

    const line = `${trade.ticker.padEnd(6)} | ${status.padEnd(7)} | ${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(1)}% | score ${score}/10 | ${positiveDays}/${closes.length} pos-days | held ${Math.round(daysHeld)}d${trimHint}`;
    lines.push(line);
    log(`[HealthCheck] ${line}`);

    persistEvent(trade.ticker,
      status === 'zombie' ? 'warning' : status === 'strong' ? 'success' : 'info',
      `[HealthCheck] ${status}: ${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(1)}% | ${positiveDays}/${closes.length} positive days | score ${score}/10`,
      {
        action: 'health_check',
        source: 'compounder_health',
        mode: 'LONG_TERM',
        metadata: {
          status, gainPct, positiveDays, totalDays: closes.length,
          ratio, score, daysHeld: Math.round(daysHeld),
          entryPrice, currentPrice, trimHint: trimHint || null,
        },
      }
    );
  }

  if (lines.length > 0) {
    log(`[HealthCheck] Summary:\n${lines.map(l => `  ${l}`).join('\n')}`);
  }
}

// ── IB Position Reconciliation ───────────────────────────────────────────────
// Detects IB positions with no active FILLED paper_trade and creates records
// so position management modules (profit take, loss cut, auto-sell) can act on
// them. Runs once per day to avoid churn.

let _lastReconcileDate = '';

async function reconcileOrphanedPositions(
  positions: EnrichedPosition[],
): Promise<void> {
  const today = getETDateString();
  if (_lastReconcileDate === today) return;

  const sb = getSupabase();
  const activeTrades = await getActiveTrades();
  const filledTickers = new Set(
    activeTrades
      .filter(t => t.status === 'FILLED')
      .map(t => t.ticker.toUpperCase())
  );

  // Also skip tickers that were closed/sold today — prevents the
  // reconcile→auto-sell→reconcile loop (CSCO/AMAT bug 2026-05-14).
  const todayStart = `${today}T00:00:00`;
  const { data: closedToday } = await sb
    .from('paper_trades')
    .select('ticker')
    .eq('mode', 'LONG_TERM')
    .in('status', [...CLOSED_STATUSES])
    .gte('closed_at', todayStart);
  const closedTodayTickers = new Set(
    (closedToday ?? []).map((r: { ticker: string }) => r.ticker.toUpperCase())
  );

  // Load historical LONG_TERM records to identify SF tickers
  const { data: historicalLT } = await sb
    .from('paper_trades')
    .select('ticker')
    .eq('mode', 'LONG_TERM')
    .eq('signal', 'BUY')
    .in('status', [...CLOSED_STATUSES]);
  const knownLTTickers = new Set(
    (historicalLT ?? []).map((r: { ticker: string }) => r.ticker.toUpperCase())
  );

  let reconciled = 0;
  for (const ibPos of positions) {
    const ticker = ibPos.symbol.toUpperCase();
    if (ibPos.position <= 0) continue;
    if (ibPos.mktPrice <= 0) continue;
    if (ibPos.avgCost <= 0) continue;
    if (filledTickers.has(ticker)) continue;
    if (closedTodayTickers.has(ticker)) continue;
    if (!knownLTTickers.has(ticker)) continue;

    const qty = Math.abs(ibPos.position);
    const posSize = qty * ibPos.avgCost;

    await createPaperTrade({
      ticker,
      mode: 'LONG_TERM',
      status: 'FILLED',
      signal: 'BUY',
      fill_price: ibPos.avgCost,
      quantity: qty,
      position_size: posSize,
      filled_at: new Date().toISOString(),
      notes: 'Reconciled: orphaned IB position (no active FILLED record)',
      entry_trigger_type: 'reconciliation',
    });

    log(`[Reconcile] ${ticker}: created FILLED record — ${qty} shares @ $${ibPos.avgCost.toFixed(2)} ($${posSize.toFixed(0)})`);
    reconciled++;
    filledTickers.add(ticker);
  }

  _lastReconcileDate = today;
  if (reconciled > 0) {
    log(`[Reconcile] Created ${reconciled} FILLED records for orphaned IB positions`);
    summaryLog(`Reconciled ${reconciled} orphaned IB positions`);
  }
}

async function checkDipBuyOpportunities(
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
): Promise<void> {
  if (!config.dipBuyEnabled || !config.accountId) return;
  if (!isModeEnabled(config, 'LONG_TERM')) return;
  // Resolve LONG_TERM routing for dip buys
  let dipConnections: RoutedConnection[];
  try {
    dipConnections = getConnectionForMode('LONG_TERM', config).connections;
  } catch { return; }
  const dipAcct = dipConnections[0].accountType;

  const activeTrades = await getActiveTrades(dipAcct);
  const longTermFilled = activeTrades.filter(t => t.mode === 'LONG_TERM' && t.status === 'FILLED');

  const initialByTicker = new Map<string, { trade: PaperTrade; isGoldMine: boolean }>();
  const openEntriesByTicker = new Map<string, number>();
  for (const t of longTermFilled) {
    const tk = t.ticker.toUpperCase();
    openEntriesByTicker.set(tk, (openEntriesByTicker.get(tk) ?? 0) + 1);
    if ((t.notes ?? '').startsWith('Dip buy')) continue;
    if (!initialByTicker.has(t.ticker)) {
      const isGoldMine = /Gold Mine/i.test((t.notes ?? '') + (t.scanner_reason ?? ''));
      initialByTicker.set(t.ticker, { trade: t, isGoldMine });
    }
  }

  const tiers = [
    { pct: config.dipBuyTier3Pct, sizePct: config.dipBuyTier3SizePct, label: 'Tier 3' },
    { pct: config.dipBuyTier2Pct, sizePct: config.dipBuyTier2SizePct, label: 'Tier 2' },
    { pct: config.dipBuyTier1Pct, sizePct: config.dipBuyTier1SizePct, label: 'Tier 1' },
  ];

  // Max 3 open entries per ticker across all channels (SC + dip buys combined).
  // Prevents the POOL trap: 8 entries while the stock kept falling.
  const MAX_ENTRIES_PER_TICKER = 3;

  for (const [ticker, { trade, isGoldMine }] of initialByTicker) {
    const ibPos = positions.find(p => p.symbol.toUpperCase() === ticker.toUpperCase());
    if (!ibPos || ibPos.mktPrice <= 0 || ibPos.avgCost <= 0) continue;

    const dipPct = ((ibPos.mktPrice - ibPos.avgCost) / ibPos.avgCost) * 100;
    if (dipPct >= 0) continue;
    const absDip = Math.abs(dipPct);

    let triggered = tiers.find(t => absDip >= t.pct);
    if (!triggered) continue;
    if (isGoldMine && triggered.label === 'Tier 3') continue;

    // ── Cross-channel entry cap ────────────────────────────────────────────
    const totalEntries = openEntriesByTicker.get(ticker.toUpperCase()) ?? 1;
    if (totalEntries >= MAX_ENTRIES_PER_TICKER) {
      log(`${ticker}: Dip buy blocked — ${totalEntries} open entries already (max ${MAX_ENTRIES_PER_TICKER} per ticker)`);
      continue;
    }

    // ── Thesis gate (for Compounders only) ────────────────────────────────
    // Only dip-buy if the stock has shown it CAN go up: at least 1 positive close
    // since original entry after the 20-day grace window. Stocks that never close
    // above their entry price after 20 days are "zombies" — adding more capital
    // into them compounds losses rather than averaging into a quality dip.
    if (!isGoldMine) {
      const daysHeld = trade.filled_at
        ? (Date.now() - new Date(trade.filled_at).getTime()) / 86400000
        : 0;
      const pricePeak = trade.price_peak ?? 0;
      const entryFill = trade.fill_price ?? ibPos.avgCost;
      const everAboveEntry = pricePeak > entryFill * 1.001; // >0.1% buffer
      if (daysHeld >= 20 && !everAboveEntry) {
        log(`${ticker}: Dip buy blocked — thesis gate: 0 positive closes in ${daysHeld.toFixed(0)} days (zombie check). Review fundamentals before adding.`);
        continue;
      }
    }

    // Cooldown
    const recentEvents = await getRecentDipBuyEvents(ticker);
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
    let sizePct = triggered.sizePct;
    if (isGoldMine && triggered.label === 'Tier 2') sizePct *= 0.5;
    const addOnQty = Math.max(1, Math.floor(originalQty * (sizePct / 100)));
    const addOnDollar = addOnQty * ibPos.mktPrice;

    if (!(await checkAllocationCap(config, addOnDollar, ticker, positions, 'LONG_TERM'))) continue;

    let dipExecuted = false;
    for (const { connection: dipConn, accountType: dipAcctType } of dipConnections) {
      try {
        if (!dipConn.isConnected()) {
          if (dipExecuted) continue;
          break;
        }

        if (dipAcctType === 'live') {
          try { await assertLiveLossLimitNotBreached(config); } catch {
            if (dipExecuted) continue;
            break;
          }
        }

        const result = await dipConn.placeMarketOrder({
          symbol: ticker, side: 'BUY', quantity: addOnQty,
        });

        await createPaperTrade({
          ticker, mode: 'LONG_TERM', signal: 'BUY',
          scanner_confidence: trade.scanner_confidence,
          fa_confidence: trade.fa_confidence,
          fa_recommendation: 'BUY',
          entry_price: ibPos.mktPrice,
          quantity: addOnQty, position_size: addOnDollar,
          ib_order_id: String(result.orderId),
          status: 'SUBMITTED',
          notes: `Dip buy ${triggered.label} at -${absDip.toFixed(1)}%`,
          entry_trigger_type: 'dip_buy',
        }, dipAcctType);

        if (!dipExecuted) recordPendingOrder(addOnDollar);
        log(`${ticker}: DIP BUY ${triggered.label} [${dipAcctType}] — +${addOnQty} shares at -${absDip.toFixed(1)}%`);
        persistEvent(ticker, 'success', `Dip buy ${triggered.label}: +${addOnQty} shares`, {
          action: 'executed', source: 'dip_buy', mode: 'LONG_TERM',
          metadata: { tier: triggered.label, dipPct: absDip, addOnQty, addOnDollar },
        }, dipAcctType);
        dipExecuted = true;
      } catch (err) {
        log(`${ticker}: [${dipAcctType}] Dip buy failed — ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }
  }
}

// ── Capital Recycling ────────────────────────────────────

/**
 * Auto-exit swing trades that have been held past swingMaxHoldDays.
 * Swing trades are meant to be short-duration (days, not weeks). If one is still open after N days
 * the thesis likely didn't play out — free the capital for new opportunities.
 */
async function checkSwingHoldExpiry(
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
): Promise<void> {
  const maxDays = config.swingMaxHoldDays ?? 5;
  if (maxDays <= 0 || !config.accountId) return;

  let swingConnections: RoutedConnection[];
  try {
    swingConnections = getConnectionForMode('SWING_TRADE', config).connections;
  } catch { return; }
  const swingAcct = swingConnections[0].accountType;

  const activeTrades = await getActiveTrades(swingAcct);
  // Count trading days (Mon–Fri, excl. holidays) — calendar days inflate the count
  // over weekends and make a 15-day hold appear as 21 calendar days.
  const stale = activeTrades.filter(t =>
    t.mode === 'SWING_TRADE' &&
    t.status === 'FILLED' &&
    t.filled_at != null &&
    countTradingDaysSince(new Date(t.filled_at)) > maxDays
  );

  for (const trade of stale) {
    const ibPos = positions.find(p => p.symbol.toUpperCase() === trade.ticker.toUpperCase());
    if (!ibPos || ibPos.position === 0) continue;

    const qty = Math.abs(ibPos.position);
    const side: 'BUY' | 'SELL' = ibPos.position > 0 ? 'SELL' : 'BUY';
    const daysHeld = countTradingDaysSince(new Date(trade.filled_at!));
    const gainPct = ibPos.avgCost > 0
      ? ((ibPos.mktPrice - ibPos.avgCost) / ibPos.avgCost * 100).toFixed(1)
      : '?';

    for (const { connection: swingConn, accountType: swAcct } of swingConnections) {
      try {
        const result = await swingConn.placeMarketOrder({ symbol: trade.ticker, side, quantity: qty });
        await recordTradeClose({
          tradeId: trade.id,
          closePrice: result.avgFillPrice,
          closeReason: 'swing_expiry',
          status: 'CLOSED',
          orderId: result.orderId,
          accountType: swAcct,
        });

        log(`${trade.ticker}: SWING EXPIRY [${swAcct}] — held ${daysHeld} days, closing ${qty} shares at ${gainPct}% P&L`);
        persistEvent(trade.ticker, 'success',
          `${trade.ticker} swing auto-closed after ${daysHeld} days (max ${maxDays}d) — P&L ${gainPct}% — capital freed`,
          { action: 'closed', source: 'swing_expiry', mode: 'SWING_TRADE',
            metadata: { daysHeld, maxDays, gainPct, qty } },
          swAcct,
        );
      } catch (err) {
        log(`${trade.ticker}: [${swAcct}] Swing expiry close failed — ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }
  }
}

/**
 * Auto-exit long-term (Suggested Finds) positions via:
 *   1. Profit-take  — close if PnL% >= ltProfitTakePct (e.g. +15%)
 *   2. Trailing stop — close if price falls ltTrailingStopPct% from its peak,
 *                      BUT only if the peak was above the entry price (was ever in profit).
 *                      This takes profits on the way down without bag-holding losers.
 *   3. Fixed stop-loss — disabled by default (ltStopLossPct = 0), kept as fallback.
 *
 * Also updates price_peak on every cycle so the trailing stop tracks correctly.
 */
// ── Gold Mine Archetype Exit Rules ────────────────────────────────────────────
// Gold Mines are discovered from current headlines → macro is already partially
// priced in. Exit rules are archetype-specific because theme duration differs.
// Calendar-day thresholds approximate trading days (×7/5 conversion).
// See .cursor/rules/long-term-sizing.mdc for full rationale.

type GoldMineArchetype = 'Tech/Semi' | 'Defense' | 'Energy' | 'Financials' | 'Unknown';

interface GoldMineArchetypeRules {
  maxHoldCalDays: number;   // max hold in calendar days before forced exit
  hardStopCalDays: number;  // calendar days: exit if stock never closed above entry
  profitTakePct: number;    // sell when gain >= this %
  entryLockPct: number;     // once peak >= entry + this %, stop moves to entry price
  noBounceExceptionCalDays: number; // Tech/Semi only: if no bounce after N cal days → apply Defense rules
}

const GM_ARCHETYPE_RULES: Record<GoldMineArchetype, GoldMineArchetypeRules> = {
  // Fundamentally backed — AI capex is multi-year. But winners must be captured.
  // Evidence: ASML peaked +9% Day 8, MU +13.8% Day 29, AMAT +10.6% Day 8.
  'Tech/Semi':  { maxHoldCalDays: 84, hardStopCalDays: 7,  profitTakePct: 10,  entryLockPct: 5,   noBounceExceptionCalDays: 16 },
  // Pure news-cycle — conflict peaks, then mean-reverts fast. LMT/RTX never recovered.
  'Defense':    { maxHoldCalDays: 10, hardStopCalDays: 4,  profitTakePct: 0.5, entryLockPct: 0.1, noBounceExceptionCalDays: 0 },
  // Supply shock / transition themes: 3–6 week window, volatile.
  'Energy':     { maxHoldCalDays: 28, hardStopCalDays: 7,  profitTakePct: 2,   entryLockPct: 2,   noBounceExceptionCalDays: 0 },
  // Macro regime plays: gradual moves, limit exposure time.
  'Financials': { maxHoldCalDays: 21, hardStopCalDays: 6,  profitTakePct: 1.5, entryLockPct: 1.5, noBounceExceptionCalDays: 0 },
  // Unknown: conservative defaults — treat like Defense until classified
  'Unknown':    { maxHoldCalDays: 14, hardStopCalDays: 4,  profitTakePct: 2,   entryLockPct: 1,   noBounceExceptionCalDays: 0 },
};

function detectGoldMineArchetype(notes: string | null, scannerReason: string | null): GoldMineArchetype {
  const text = `${notes ?? ''} ${scannerReason ?? ''}`;

  // Explicit archetype tag wins (written by AI prompt going forward)
  if (/Archetype:\s*Tech\/Semi/i.test(text)) return 'Tech/Semi';
  if (/Archetype:\s*Defense/i.test(text)) return 'Defense';
  if (/Archetype:\s*Energy/i.test(text)) return 'Energy';
  if (/Archetype:\s*Financials/i.test(text)) return 'Financials';

  // Keyword fallback for existing trades without explicit tag
  if (/defense|military|geopolit|\bwar\b|conflict|Iran.*conflict|missile|lockheed|raytheon|\bRTX\b|\bLMT\b|\bNOC\b|\bGD\b|\bBA\b/i.test(text)) return 'Defense';
  if (/semiconductor|chip|wafer|lithography|ASML|AMAT|applied.material|micron|\bMU\b|HBM|foundry|fab\b|AI.infra|AI infrastructure/i.test(text)) return 'Tech/Semi';
  if (/\bAI\b|cloud|software|cyber|network|data.center|infrastructure.spending|FTNT|fortinet/i.test(text)) return 'Tech/Semi';
  if (/\boil\b|energy|solar|renewable|fossil|natural.gas|FSLR|first.solar|ENPH|enphase|EOG/i.test(text)) return 'Energy';
  if (/bank|financial|\brate\b|\bdollar\b|JPMorgan|\bJPM\b|Ally|\bALLY\b|lending|credit|normali/i.test(text)) return 'Financials';

  return 'Unknown';
}

async function checkLongTermAutoSell(
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
  skipTickers?: Set<string>,
): Promise<void> {
  const compounderProfitTakePct = config.ltProfitTakePct ?? 15;
  const compounderMaxHoldDays   = config.ltMaxHoldDays ?? 0;
  const compounderTrailingStop  = config.ltTrailingStopPct ?? 10;
  const compounderStopLossPct   = config.ltStopLossPct ?? 0;

  if (!config.accountId) return;

  let ltConnections: RoutedConnection[];
  try {
    ltConnections = getConnectionForMode('LONG_TERM', config).connections;
  } catch { return; }
  const ltAcct = ltConnections[0].accountType;

  const activeTrades = await getActiveTrades(ltAcct);
  // Only BUY records are actual open positions. SELL records (profit-take trims)
  // must be excluded — they are completed actions, not positions to close.
  // Also deduplicate by ticker to prevent multiple sells against the same IB position.
  const longTermOpen = activeTrades.filter(t => t.mode === 'LONG_TERM' && t.status === 'FILLED' && t.signal === 'BUY');
  const today = new Date().toISOString().slice(0, 10);
  const processedTickers = new Set<string>();

  for (const trade of longTermOpen) {
    const tickerUpper = trade.ticker.toUpperCase();
    if (processedTickers.has(tickerUpper)) {
      log(`${trade.ticker}: skipping LT auto-sell — already processed this cycle (dedup)`);
      continue;
    }
    if (skipTickers?.has(tickerUpper)) {
      log(`${trade.ticker}: skipping LT auto-sell — already trimmed by profit-take this cycle`);
      continue;
    }
    const ibPos = positions.find(p => p.symbol.toUpperCase() === tickerUpper);
    if (!ibPos || ibPos.position === 0) continue;

    const currentPrice = ibPos.mktPrice;
    if (currentPrice <= 0) continue; // IB data gap — skip, don't trigger false exits
    const entryPrice   = ibPos.avgCost;
    if (entryPrice <= 0) continue;
    const gainPct      = (currentPrice - entryPrice) / entryPrice * 100;
    const daysHeld     = trade.filled_at
      ? (Date.now() - new Date(trade.filled_at).getTime()) / 86400000
      : 0;

    // Track price peak across cycles
    const storedPeak = trade.price_peak ?? 0;
    if (currentPrice > storedPeak || !trade.price_peak_date) {
      await updatePaperTrade(trade.id, { price_peak: currentPrice, price_peak_date: today }, ltAcct);
    }
    const effectivePeak = Math.max(storedPeak, currentPrice);
    // Was this position ever meaningfully above entry (>0.1% buffer for noise)?
    const everAboveEntry = effectivePeak > entryPrice * 1.001;

    let reason: string | null = null;
    const tradeNotes = `${trade.notes ?? ''} ${trade.scanner_reason ?? ''}`;
    const isGoldMine = /Gold Mine/i.test(tradeNotes);
    const isDipDiscovery = /Dip Discovery/i.test(tradeNotes);

    if (isDipDiscovery) {
      // ── Dip Discovery: mean-reversion exit rules ────────────────────────
      // Take-profit = 40% recovery of the drawdown from 52-week high.
      // Parse stored 52-week high from notes to compute the dynamic target.
      const high52wMatch = tradeNotes.match(/52wHigh:\s*([\d.]+)/);
      const high52w = high52wMatch ? parseFloat(high52wMatch[1]) : 0;

      let dipTpPct = 20; // fallback: +20% from entry
      if (high52w > 0 && entryPrice > 0 && high52w > entryPrice) {
        const drawdownDollars = high52w - entryPrice;
        const recoveryTarget = entryPrice + drawdownDollars * 0.40;
        dipTpPct = ((recoveryTarget - entryPrice) / entryPrice) * 100;
      }

      if (gainPct >= dipTpPct) {
        reason = `dd_profit_take:+${gainPct.toFixed(1)}%>=${dipTpPct.toFixed(1)}% (40% recovery)`;
      } else if (gainPct <= -15) {
        reason = `dd_stop_loss:${gainPct.toFixed(1)}%<=-15%`;
      } else if (daysHeld >= 120) {
        reason = `dd_max_hold:${daysHeld.toFixed(0)}d>=120d`;
      }
    } else if (isGoldMine) {
      // ── Gold Mine: archetype-specific exit rules ──────────────────────────
      const archetype = detectGoldMineArchetype(trade.notes ?? null, trade.scanner_reason ?? null);
      let rules = GM_ARCHETYPE_RULES[archetype];

      // ADBE-class exception: Tech/Semi that never bounced after 11 trading days (~16 cal days)
      // → treat it as Defense (apply its hard stop immediately going forward).
      if (
        archetype === 'Tech/Semi' &&
        rules.noBounceExceptionCalDays > 0 &&
        daysHeld >= rules.noBounceExceptionCalDays &&
        !everAboveEntry
      ) {
        log(`${trade.ticker}: Tech/Semi Gold Mine — no bounce in ${daysHeld.toFixed(0)} cal days, applying Defense rules (ADBE-class exception)`);
        rules = GM_ARCHETYPE_RULES['Defense'];
      }

      const peakGainPct = entryPrice > 0 ? (effectivePeak - entryPrice) / entryPrice * 100 : 0;

      // 1. Entry price lock: once peak >= entryLockPct, stop is at entry — never let winner go negative
      if (rules.entryLockPct > 0 && peakGainPct >= rules.entryLockPct && gainPct <= 0) {
        reason = `gm_entry_lock:peak_was_+${peakGainPct.toFixed(1)}%_now_${gainPct.toFixed(1)}% (${archetype})`;
      }
      // 2. Profit take
      else if (gainPct >= rules.profitTakePct) {
        reason = `gm_profit_take:+${gainPct.toFixed(1)}%>=${rules.profitTakePct}% (${archetype})`;
      }
      // 3. Hard stop: never went above entry after N calendar days
      else if (daysHeld >= rules.hardStopCalDays && !everAboveEntry) {
        reason = `gm_hard_stop:no_bounce_${daysHeld.toFixed(0)}d (${archetype})`;
      }
      // 4. Max hold
      else if (daysHeld >= rules.maxHoldCalDays) {
        reason = `gm_max_hold:${daysHeld.toFixed(0)}d>=${rules.maxHoldCalDays}d (${archetype})`;
      }
    } else {
      // ── Steady Compounder ──────────────────────────────────────────────────
      if (gainPct >= compounderProfitTakePct) {
        // Profit target always fires — macro circuit breaker does not suppress gains.
        reason = `profit_take:+${gainPct.toFixed(1)}%>=${compounderProfitTakePct}%`;
      } else if (
        compounderTrailingStop > 0 &&
        effectivePeak > entryPrice &&
        currentPrice < effectivePeak * (1 - compounderTrailingStop / 100)
      ) {
        const dropFromPeak = ((effectivePeak - currentPrice) / effectivePeak * 100).toFixed(1);
        reason = `trailing_stop:${dropFromPeak}%_from_peak($${effectivePeak.toFixed(2)})`;
      } else if (gainPct <= -8 && daysHeld >= 10 && !everAboveEntry) {
        // Hard stop for Compounders: if down 8%+ and never bounced above entry
        // after 10 calendar days, the thesis is broken. Data shows Compounders
        // that don't bounce are 0% WR and bleed indefinitely.
        reason = `sc_hard_stop:${gainPct.toFixed(1)}%_no_bounce_${daysHeld.toFixed(0)}d`;
      } else if (compounderStopLossPct < 0 && gainPct <= compounderStopLossPct) {
        // Macro circuit breaker: if SPY has dropped >5% in the last 5 trading days,
        // this is broad-market turbulence, not a broken business thesis. Suspend the
        // stop-loss for one cycle and re-evaluate next run.
        const spy5d = await fetchSpy5DayChangePct();
        if (spy5d !== null && spy5d <= -5) {
          log(`${trade.ticker}: Compounder stop-loss suppressed — SPY 5d = ${spy5d.toFixed(1)}% (macro selloff circuit breaker)`);
        } else {
          reason = `stop_loss:${gainPct.toFixed(1)}%<=${compounderStopLossPct}%`;
        }
      } else if (compounderMaxHoldDays > 0 && daysHeld >= compounderMaxHoldDays) {
        reason = `max_hold:${daysHeld.toFixed(0)}d>=${compounderMaxHoldDays}d`;
      }
    }

    if (!reason) continue;

    const qty  = Math.abs(ibPos.position);
    const side: 'BUY' | 'SELL' = ibPos.position > 0 ? 'SELL' : 'BUY';

    processedTickers.add(tickerUpper);

    for (const { connection: ltConn, accountType: ltAcctType } of ltConnections) {
      try {
        const result = await ltConn.placeMarketOrder({ symbol: trade.ticker, side, quantity: qty });
        const avgFillPrice = result.avgFillPrice;
        const fillPnlPct = ibPos.avgCost > 0
          ? ((avgFillPrice - ibPos.avgCost) / ibPos.avgCost) * 100
          : gainPct;
        await recordTradeClose({
          tradeId: trade.id,
          closePrice: avgFillPrice,
          closeReason: reason,
          status: 'CLOSED',
          orderId: result.orderId,
          accountType: ltAcctType,
        });

        const label = reason.startsWith('dd_profit_take') ? 'Dip Discovery profit-take'
          : reason.startsWith('dd_stop_loss')    ? 'Dip Discovery stop-loss'
          : reason.startsWith('dd_max_hold')     ? 'Dip Discovery max-hold exit'
          : reason.startsWith('gm_profit_take')  ? 'GM profit-take'
          : reason.startsWith('gm_entry_lock')   ? 'GM entry-lock exit'
          : reason.startsWith('gm_hard_stop')    ? 'GM hard stop (no bounce)'
          : reason.startsWith('gm_max_hold')     ? 'GM max-hold exit'
          : reason.startsWith('sc_hard_stop')    ? 'Compounder hard stop (no bounce)'
          : reason.startsWith('profit_take')     ? 'profit-take'
          : reason.startsWith('trailing_stop')   ? 'trailing stop'
          : reason.startsWith('stop_loss')       ? 'stop-loss'
          : 'max-hold exit';
        log(`${trade.ticker}: LT AUTO-SELL [${ltAcctType}] (${label}) — ${fillPnlPct.toFixed(1)}% P&L, fill $${avgFillPrice.toFixed(2)}, peak $${effectivePeak.toFixed(2)}, held ${daysHeld.toFixed(0)}d`);
        persistEvent(trade.ticker, 'success',
          `${trade.ticker} long-term auto-closed (${label}) — ${fillPnlPct.toFixed(1)}% P&L @ $${avgFillPrice.toFixed(2)} — capital freed`,
          { action: 'closed', source: 'lt_auto_sell', mode: 'LONG_TERM',
            metadata: { reason, gainPct: fillPnlPct, daysHeld, qty, effectivePeak, entryPrice, avgFillPrice } },
          ltAcctType,
        );
      } catch (err) {
        log(`${trade.ticker}: [${ltAcctType}] Long-term auto-sell failed — ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }
  }
}

/**
 * Capital-pressure redeployment: when deployed capital > 90% of cap, find the swing trade
 * with the highest unrealized gain and close it to free capital for a new signal.
 * Returns the dollar amount freed (0 if nothing closed).
 */
async function makeRoomForTrade(
  config: AutoTraderConfig,
  neededDollars: number,
  positions: EnrichedPosition[],
): Promise<number> {
  if (!config.capitalPressureEnabled || !config.accountId) return 0;

  const activeTrades = await getActiveTrades();
  const swingsFilled = activeTrades.filter(t =>
    t.mode === 'SWING_TRADE' && t.status === 'FILLED'
  );

  // Build candidates with live P&L from IB positions, sorted best gain first
  const candidates = swingsFilled
    .map(t => {
      const ibPos = positions.find(p => p.symbol.toUpperCase() === t.ticker.toUpperCase());
      if (!ibPos || ibPos.position === 0 || ibPos.avgCost <= 0) return null;
      const gainPct = (ibPos.mktPrice - ibPos.avgCost) / ibPos.avgCost * 100;
      const marketValue = Math.abs(ibPos.position) * ibPos.mktPrice;
      return { trade: t, ibPos, gainPct, marketValue };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => b.gainPct - a.gainPct); // best gain first — take profits before taking losses

  for (const candidate of candidates) {
    if (candidate.marketValue < neededDollars * 0.8) continue; // not worth the round-trip if too small

    const qty = Math.abs(candidate.ibPos.position);
    const side: 'BUY' | 'SELL' = candidate.ibPos.position > 0 ? 'SELL' : 'BUY';

    try {
      const result = await placeMarketOrder({ symbol: candidate.trade.ticker, side, quantity: qty });
      await recordTradeClose({
        tradeId: candidate.trade.id,
        closePrice: result.avgFillPrice,
        closeReason: 'capital_pressure',
        status: 'CLOSED',
        orderId: result.orderId,
        accountType: 'paper',
      });

      log(`Capital pressure: closed ${candidate.trade.ticker} (+${candidate.gainPct.toFixed(1)}%) to free $${candidate.marketValue.toFixed(0)}`);
      persistEvent(candidate.trade.ticker, 'success',
        `♻️ ${candidate.trade.ticker} closed to free capital (+${candidate.gainPct.toFixed(1)}% gain) — $${candidate.marketValue.toFixed(0)} freed for new signal`,
        { action: 'closed', source: 'capital_pressure', mode: 'SWING_TRADE',
          metadata: { gainPct: candidate.gainPct, freed: candidate.marketValue } }
      );
      return candidate.marketValue;
    } catch (err) {
      log(`Capital pressure close failed for ${candidate.trade.ticker}: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  return 0;
}

async function checkProfitTakeOpportunities(
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
): Promise<Set<string>> {
  const trimmedTickers = new Set<string>();
  if (!config.profitTakeEnabled || !config.accountId) return trimmedTickers;

  let ptConnections: RoutedConnection[];
  try {
    ptConnections = getConnectionForMode('LONG_TERM', config).connections;
  } catch { return trimmedTickers; }
  const ptAcct = ptConnections[0].accountType;

  const activeTrades = await getActiveTrades(ptAcct);
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

    const pastEvents = await getPastTrimEvents(trade.ticker);
    if (pastEvents.some(e => e.metadata?.tier === triggered.label)) continue;

    const originalQty = trade.quantity ?? Math.abs(ibPos.position);
    const currentQty = Math.abs(ibPos.position);
    const minHoldQty = Math.ceil(originalQty * (config.minHoldPct / 100));
    const trimQty = Math.max(1, Math.floor(currentQty * (triggered.trimPct / 100)));
    const actualTrimQty = Math.min(trimQty, currentQty - minHoldQty);
    if (actualTrimQty < 1) continue;

    for (const { connection: ptConn, accountType: ptAcctType } of ptConnections) {
      try {
        if (!ptConn.isConnected()) continue;

        const { orderId, avgFillPrice } = await ptConn.placeMarketOrder({
          symbol: trade.ticker, side: 'SELL', quantity: actualTrimQty,
        });

        const realizedPnl = actualTrimQty * (avgFillPrice - ibPos.avgCost);

        await createPaperTrade({
          ticker: trade.ticker, mode: 'LONG_TERM', signal: 'SELL',
          entry_price: avgFillPrice,
          fill_price: avgFillPrice,
          quantity: actualTrimQty,
          position_size: actualTrimQty * avgFillPrice,
          status: 'CLOSED',
          ib_order_id: String(orderId),
          pnl: realizedPnl,
          pnl_source: 'ib_fill_calculated',
          close_reason: 'profit_take',
          closed_at: new Date().toISOString(),
          notes: `Profit take ${triggered.label} at +${gainPct.toFixed(1)}%`,
          entry_trigger_type: 'profit_take',
        }, ptAcctType);

        trimmedTickers.add(trade.ticker.toUpperCase());
        log(`${trade.ticker}: PROFIT TAKE ${triggered.label} [${ptAcctType}] — sold ${actualTrimQty} shares @ $${avgFillPrice.toFixed(2)}, +${gainPct.toFixed(1)}% ($${realizedPnl.toFixed(2)})`);
        persistEvent(trade.ticker, 'success', `Profit take ${triggered.label}: sold ${actualTrimQty} shares @ $${avgFillPrice.toFixed(2)}`, {
          action: 'executed', source: 'profit_take', mode: 'LONG_TERM',
          metadata: { tier: triggered.label, gainPct, trimQty: actualTrimQty, realizedPnl, fillPrice: avgFillPrice, orderId },
        }, ptAcctType);
      } catch (err) {
        log(`${trade.ticker}: [${ptAcctType}] Profit take failed — ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }
  }
  return trimmedTickers;
}

// ── Day-Trade Software Trailing Stop ──────────────────────────────────────────
//
// Activates once a day trade has moved +1R in your favour (i.e. you've "earned"
// as much as you risked). From that point it trails: if the position pulls back
// more than 50% of the peak gain from entry, a market-close order fires.
//
// This runs every scheduler cycle (every ~15 min) ON TOP of the existing IB
// bracket — it doesn't cancel bracket orders, it's just an extra software layer
// that catches large reversals the fixed bracket stop can't adjust for.
//
// Config:
//   TRAIL_ACTIVATION_R  — gain multiple of initial risk before trail kicks in (1.0 = 1R)
//   TRAIL_RETRACE_PCT   — fraction of peak gain that can retrace before close (0.50 = 50%)

const TRAIL_ACTIVATION_R  = 0.5;  // activate at +0.5R (was 1.0 — only 5/430 trades ever triggered)
const TRAIL_RETRACE_PCT   = 0.60; // close if 60% of peak gain retraces (was 0.50)

async function checkDayTradeTrailingStops(
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
): Promise<void> {
  // Day trades may be on different accounts based on mode routing
  for (const acctType of ['paper', 'live'] as AccountType[]) {
    const conn = getConnectionForAccount(acctType);
    if (!conn.isConnected()) continue;

    const activeTrades = await getActiveTrades(acctType);
    const dayTrades = activeTrades.filter(
      t => (t.mode === 'DAY_TRADE' || t.mode === 'DAY_PENNY') && (t.status === 'FILLED' || t.status === 'PARTIAL'),
    );
    if (dayTrades.length === 0) continue;

    for (const trade of dayTrades) {
      const ibPos = positions.find(p => p.symbol.toUpperCase() === trade.ticker.toUpperCase());
      if (!ibPos || ibPos.mktPrice <= 0) continue;

      const fillPrice  = trade.fill_price ?? trade.entry_price ?? 0;
      const stopPrice  = trade.stop_loss ?? 0;
      if (!fillPrice || !stopPrice) continue;

      const risk = Math.abs(fillPrice - stopPrice);
      if (risk <= 0) continue;

      const currentPrice = ibPos.mktPrice;
      const isBuy = trade.signal === 'BUY';

      const gainInR = isBuy
        ? (currentPrice - fillPrice) / risk
        : (fillPrice - currentPrice) / risk;

      if (gainInR < TRAIL_ACTIVATION_R) continue;

      const storedPeak = trade.price_peak ?? 0;
      const newPeak = isBuy
        ? Math.max(storedPeak, currentPrice)
        : (storedPeak <= 0 ? currentPrice : Math.min(storedPeak, currentPrice));

      if (newPeak !== storedPeak) {
        await updatePaperTrade(trade.id, { price_peak: newPeak }, acctType);
      }

      const peakGain    = Math.abs(newPeak - fillPrice);
      const trailDist   = peakGain * TRAIL_RETRACE_PCT;
      const trailStop   = isBuy ? newPeak - trailDist : newPeak + trailDist;
      const violated    = isBuy ? currentPrice <= trailStop : currentPrice >= trailStop;

      log(
        `${trade.ticker}: trail check [${acctType}] — fill ${fillPrice} peak ${newPeak.toFixed(2)} ` +
        `current ${currentPrice.toFixed(2)} trailStop ${trailStop.toFixed(2)} ` +
        `(+${gainInR.toFixed(1)}R) ${violated ? '→ TRIGGERED' : 'ok'}`,
      );

      if (!violated) continue;

      const closeSide = isBuy ? 'SELL' : 'BUY';
      const qty       = trade.quantity ?? 0;
      if (qty <= 0) continue;

      // Cancel bracket TP/SL orders to prevent duplicate sells
      if (trade.ib_tp_order_id) {
        try { conn.cancelOrder(parseInt(trade.ib_tp_order_id, 10)); log(`${trade.ticker}: trailing stop — cancelled bracket TP #${trade.ib_tp_order_id}`); }
        catch (e) { log(`${trade.ticker}: trailing stop — cancel TP #${trade.ib_tp_order_id} failed: ${e instanceof Error ? e.message : 'unknown'}`); }
      }
      if (trade.ib_sl_order_id) {
        try { conn.cancelOrder(parseInt(trade.ib_sl_order_id, 10)); log(`${trade.ticker}: trailing stop — cancelled bracket SL #${trade.ib_sl_order_id}`); }
        catch (e) { log(`${trade.ticker}: trailing stop — cancel SL #${trade.ib_sl_order_id} failed: ${e instanceof Error ? e.message : 'unknown'}`); }
      }

      try {
        const result = await conn.placeMarketOrder({ symbol: trade.ticker, side: closeSide, quantity: qty });
        await recordTradeClose({
          tradeId: trade.id,
          closePrice: result.avgFillPrice,
          closeReason: 'trailing_stop',
          status: 'CLOSED',
          orderId: result.orderId,
          accountType: acctType,
        });
        log(
          `${trade.ticker}: DAY_TRADE trailing stop closed [${acctType}] — peak ${newPeak.toFixed(2)}, ` +
          `current ${currentPrice.toFixed(2)}, trail stop ${trailStop.toFixed(2)}, ` +
          `fill $${result.avgFillPrice.toFixed(2)}`,
        );
      } catch (err) {
        log(`${trade.ticker}: trailing stop close failed — ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }
  }
}

async function checkLossCutOpportunities(
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
): Promise<Set<string>> {
  const actedTickers = new Set<string>();
  if (!config.lossCutEnabled || !config.accountId) return actedTickers;

  // Loss cuts may apply to both paper and live accounts
  for (const acctType of ['paper', 'live'] as AccountType[]) {
    const conn = getConnectionForAccount(acctType);
    if (!conn.isConnected()) continue;

    const activeTrades = await getActiveTrades(acctType);
    const eligible = activeTrades.filter(t =>
      (t.mode === 'LONG_TERM' || t.mode === 'SWING_TRADE') &&
      (t.status === 'FILLED' || t.status === 'PARTIAL')
    );
    if (eligible.length === 0) continue;

    const tiers = [
      { pct: config.lossCutTier3Pct, sellPct: config.lossCutTier3SellPct, label: 'Tier 3 (full exit)' },
      { pct: config.lossCutTier2Pct, sellPct: config.lossCutTier2SellPct, label: 'Tier 2' },
      { pct: config.lossCutTier1Pct, sellPct: config.lossCutTier1SellPct, label: 'Tier 1' },
    ];

    let spyMacroSelloff = false;
    const eligibleLongTerm = eligible.filter(t => t.mode === 'LONG_TERM');
    if (eligibleLongTerm.length > 0) {
      const spy5d = await fetchSpy5DayChangePct();
      if (spy5d !== null && spy5d <= -5) {
        spyMacroSelloff = true;
        log(`[LossCut:${acctType}] SPY 5d = ${spy5d.toFixed(1)}% — macro selloff circuit breaker active: LONG_TERM loss cuts suppressed this cycle`);
      }
    }

    for (const trade of eligible) {
      const ibPos = positions.find(p => p.symbol.toUpperCase() === trade.ticker.toUpperCase());
      if (!ibPos || ibPos.mktPrice <= 0 || ibPos.avgCost <= 0) continue;

      const lossPct = ((ibPos.avgCost - ibPos.mktPrice) / ibPos.avgCost) * 100;
      if (lossPct <= 0) continue;

      if (trade.mode === 'LONG_TERM' && spyMacroSelloff) continue;

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
        const side = ibPos.position > 0 ? 'SELL' : 'BUY';
        const result = await conn.placeMarketOrder({ symbol: trade.ticker, side: side as 'BUY' | 'SELL', quantity: sellQty });

        // If this is a full exit (Tier 3), close the original trade
        if (triggered.sellPct >= 100) {
          await recordTradeClose({
            tradeId: trade.id,
            closePrice: result.avgFillPrice,
            closeReason: `loss_cut_${triggered.label.toLowerCase().replace(/\s+/g, '_')}`,
            status: 'STOPPED',
            orderId: result.orderId,
            accountType: acctType,
          });
        } else {
          // Partial loss cut — create a SELL record (can't close the original since position remains)
          await createPaperTrade({
            ticker: trade.ticker, mode: trade.mode as 'LONG_TERM' | 'SWING_TRADE',
            signal: 'SELL', entry_price: ibPos.mktPrice,
            quantity: sellQty,
            position_size: sellQty * ibPos.mktPrice,
            status: 'SUBMITTED',
            notes: `Loss cut ${triggered.label} at -${lossPct.toFixed(1)}%`,
            entry_trigger_type: 'loss_cut',
          }, acctType);
        }

        actedTickers.add(trade.ticker.toUpperCase());
        const realizedLoss = ibPos.position > 0
          ? sellQty * (ibPos.avgCost - ibPos.mktPrice)
          : sellQty * (ibPos.mktPrice - ibPos.avgCost);
        log(`${trade.ticker}: LOSS CUT ${triggered.label} [${acctType}] — sold ${sellQty} shares at -${lossPct.toFixed(1)}% ($${realizedLoss.toFixed(2)})`);
        persistEvent(trade.ticker, 'success', `Loss cut ${triggered.label}: sold ${sellQty} shares`, {
          action: 'closed', source: 'loss_cut', mode: trade.mode,
          metadata: { tier: triggered.label, lossPct, sellQty, realizedLoss },
        }, acctType);
      } catch (err) {
        log(`${trade.ticker}: Loss cut failed — ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }
  }
  return actedTickers;
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

  try {
    const positions = await getEnrichedPositions();
    await syncPositions(config, positions);
    await recalculatePerformance();
    const analyzed = await analyzeUnreviewedTrades();
    if (analyzed > 0) {
      await updatePerformancePatterns();
      log(`Rehydration: analyzed ${analyzed} unreviewed trades, updated patterns`);
    }
    _lastRehydrationDate = today;
    log('Daily rehydration complete');
  } catch (err) {
    log(`Rehydration failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // Run auto-tune once per day after rehydration completes
  await runAutoTuneStrategyConfig();
}

/**
 * Calls the auto-tune-strategy-config edge function after market close.
 * Runs once per trading day. Analyzes 30d performance and adjusts config params.
 * Results are logged to strategy_tune_log for full auditability.
 */
async function runAutoTuneStrategyConfig(): Promise<void> {
  const today = getETDateString();
  if (_lastAutoTuneDate === today) return;

  try {
    const supabaseUrl = getSupabaseUrl();
    const serviceRoleKey = getSupabaseServiceRoleKey();
    if (!supabaseUrl || !serviceRoleKey) return;

    const res = await fetch(`${supabaseUrl}/functions/v1/auto-tune-strategy-config`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ trigger: 'scheduled' }),
    });

    if (!res.ok) {
      log(`Auto-tune failed: HTTP ${res.status}`);
      return;
    }

    const result = await res.json() as {
      ok: boolean;
      decisionsCount: number;
      decisions: Array<{ param: string; oldValue: unknown; newValue: unknown; reason: string }>;
    };

    _lastAutoTuneDate = today;

    if (result.decisionsCount > 0) {
      log(`Auto-tune applied ${result.decisionsCount} config adjustment(s):`);
      for (const d of result.decisions) {
        log(`  [${d.param}] ${d.oldValue} → ${d.newValue} | ${d.reason}`);
      }
      // Invalidate EV score cache so next cycle picks up new config
      _evScoreCache = null;
    } else {
      log('Auto-tune: no config changes needed');
    }
  } catch (err) {
    log(`Auto-tune error: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

// ── Suggested Finds Pre-Generation ───────────────────────

async function preGenerateSuggestedFinds(
  config: AutoTraderConfig,
  positions: EnrichedPosition[],
): Promise<void> {
  const today = getETDateString();
  if (_lastSuggestedFindsDate === today) return;
  if (!isMarketHoursET()) return; // outside market hours — never place LT orders outside 9:30 AM–4:00 PM ET

  try {
    log('Fetching today\'s Suggested Finds...');
    const cached = await fetchDailySuggestions();
    let stocks: SuggestedStock[] = cached?.stocks ?? [];

    // If no cached results, generate server-side (no browser needed)
    if (!cached || stocks.length === 0) {
      log('No cached Suggested Finds — generating server-side...');
      try {
        const result = await generateSuggestedFinds();
        stocks = [...result.compounders, ...result.goldMines, ...(result.dipDiscoveries ?? [])].map(s => ({
          ticker: s.ticker,
          conviction: s.conviction ?? 0,
          valuationTag: s.valuationTag ?? '',
          tag: s.tag,
          reason: s.reason,
          high52w: s.high52w,
          drawdownPct: s.drawdownPct,
          sector: s.sector,
        }));
        log(`Generated ${stocks.length} Suggested Finds (${result.compounders.length} compounders, ${result.goldMines.length} gold mines, ${(result.dipDiscoveries ?? []).length} dip discoveries)`);
      } catch (genErr) {
        log(`Server-side discovery failed: ${genErr instanceof Error ? genErr.message : 'unknown'}`);
        _lastSuggestedFindsDate = today; // Don't retry — avoid exhausting AI keys
        return;
      }
    } else if (!cached.hasDipDiscoveries) {
      // Cache exists but was generated by the browser (no dip pipeline).
      // Run dip discovery independently and merge results + update cache.
      log('Cache missing dip discoveries — running dip scan...');
      try {
        const dips = await discoverDipStocks();
        if (dips.length > 0) {
          const mapped: SuggestedStock[] = dips.map(d => ({
            ticker: d.ticker,
            conviction: d.conviction ?? 7,
            valuationTag: d.valuationTag ?? 'Undervalued',
            tag: d.tag,
            reason: d.reason,
            high52w: d.high52w,
            drawdownPct: d.drawdownPct,
            sector: d.sector,
          }));
          stocks.push(...mapped);
          log(`Found ${dips.length} dip discoveries: ${dips.map(d => d.ticker).join(', ')}`);
          patchDipDiscoveriesIntoCache(dips).catch(() => {});
        } else {
          log('Dip Discovery scan: 0 qualifying stocks today');
        }
      } catch (dipErr) {
        log(`Dip Discovery failed (non-blocking): ${dipErr instanceof Error ? dipErr.message : 'unknown'}`);
      }
    }

    if (stocks.length === 0) {
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
      const goldMines = stocks.filter(s => s.tag === 'Gold Mine');
      // Top-pick threshold matches minSuggestedFindsConviction — no point auto-buying the
      // #1 pick if its conviction is below the configured minimum for this account.
      if (compounders[0] && (compounders[0].conviction ?? 0) >= minConv) topTickers.add(compounders[0].ticker);
      if (goldMines[0] && (goldMines[0].conviction ?? 0) >= minConv) topTickers.add(goldMines[0].ticker);

      // Note: removed the goldMineMinConv +1 escalation (was: if gmCount > compCount*2, raise min by 1).
      // That logic was silently blocking conviction-9 Gold Mines when the list had many candidates.
      // The 40% Gold Mine cap in executeSuggestedFindTrade already prevents over-allocation.
      const seenTickers = new Set<string>();
      const qualified = stocks.filter(s => {
        const conv = s.conviction ?? 0;
        if (conv < minConv) return false;
        if (seenTickers.has(s.ticker)) return false;
        seenTickers.add(s.ticker);
        if (s.tag === 'Dip Discovery') return false; // Disabled: tuning moat analysis before enabling auto-buy
        if (topTickers.has(s.ticker)) return true;
        const tag = (s.valuationTag ?? '').toLowerCase();
        return tag === 'deep value' || tag === 'undervalued';
      });

      const activeCount = await countActivePositions();
      const slots = config.maxPositions - activeCount;

      let anyOrderFailed = false;
      for (const stock of qualified.slice(0, Math.max(0, slots))) {
        const result = await executeSuggestedFindTrade(stock, config, positions);
        log(`  ${stock.ticker}: ${result}`);
        if (result === 'failed:order' || result === 'failed:no_price' || result === 'failed:no_contract') {
          anyOrderFailed = true;
        }
        await new Promise(r => setTimeout(r, 2000)); // rate limit
      }

      // Only lock out today if orders went through (or were legitimately skipped).
      // If all orders failed (IB down, no price), allow retry on the next cycle.
      if (!anyOrderFailed) _lastSuggestedFindsDate = today;
      return;
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

  // Set _running immediately (before any await) to prevent concurrent realtime executions
  // from racing through the guard above before either one sets the flag.
  _running = true;

  const config = await loadConfig();
  if (!config.enabled || !config.accountId) { _running = false; return; }
  if (!isModeEnabled(config, 'DAY_TRADE') && !isModeEnabled(config, 'SWING_TRADE')) { _running = false; return; }
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
    const rtDayEvals: Record<string, { status: ScanEvaluationStatus; reason: string }> = {};
    const rtSwingEvals: Record<string, { status: ScanEvaluationStatus; reason: string }> = {};
    if (newIdeas.length > 0) {
      const [activeDayCount, activeSwingCount] = await Promise.all([
        countActivePositions('paper', 'DAY_TRADE'),
        countActivePositions('paper', 'SWING_TRADE'),
      ]);
      const daySlots = Math.max(0, config.maxPositions - activeDayCount);
      const swingSlots = Math.max(0, config.maxSwingPositions - activeSwingCount);
      if (daySlots > 0 || swingSlots > 0) {
        const qualifiedDay = newIdeas
          .filter(i => i.mode !== 'SWING_TRADE' && i.confidence >= config.minScannerConfidence)
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, daySlots);
        const qualifiedSwing = newIdeas
          .filter(i => i.mode === 'SWING_TRADE' && i.confidence >= config.minSwingScannerConfidence)
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, swingSlots);
        const qualified = [...qualifiedDay, ...qualifiedSwing];
        for (const idea of qualified) {
          const result = await executeScannerTrade(idea, config, positions);
          log(`  ${idea.ticker}: ${result}`);
          const ev = scanResultToEval(result);
          if (idea.mode === 'DAY_TRADE') rtDayEvals[idea.ticker] = ev;
          else rtSwingEvals[idea.ticker] = ev;
          // Don't mark time-dependent skips as processed — conditions change throughout the day.
          // ORB status changes as price breaks out, volume increases fix illiquidity,
          // and price movement changes R/R ratios.
          if (!isRetryableSkip(result)) {
            _processedTickers.add(idea.ticker);
          }
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
    if (Object.keys(rtDayEvals).length > 0)   writeScanEvaluations('day_trades', rtDayEvals).catch(() => {});
    if (Object.keys(rtSwingEvals).length > 0)  writeScanEvaluations('swing_trades', rtSwingEvals).catch(() => {});
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

// ── Alert Helpers ─────────────────────────────────────────

/**
 * Send a critical alert email via the send-alert-email edge function.
 * Fire-and-forget — never throws, never blocks the scheduler cycle.
 */
async function sendAlert(
  alertType: string,
  subject: string,
  body: string,
  ticker?: string,
): Promise<void> {
  try {
    const supabaseUrl = getSupabaseUrl();
    const serviceRoleKey = getSupabaseServiceRoleKey();
    if (!supabaseUrl || !serviceRoleKey) return;

    const sb = getSupabase();
    const { data: cfg } = await sb
      .from('auto_trader_config')
      .select('alert_email, alerts_enabled')
      .eq('id', 'default')
      .single();

    const alertEmail = (cfg as { alert_email?: string; alerts_enabled?: boolean } | null)?.alert_email;
    const alertsEnabled = (cfg as { alert_email?: string; alerts_enabled?: boolean } | null)?.alerts_enabled ?? true;

    if (!alertEmail || !alertsEnabled) return;

    await fetch(`${supabaseUrl}/functions/v1/send-alert-email`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ alert_type: alertType, ticker, subject, body, email_to: alertEmail }),
    });
  } catch {
    // Non-blocking — never let alerting crash the scheduler
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
  _lastCycleSummary = [];
  const startTime = Date.now();

  try {
    log(`═══ Cycle #${_runCount} starting ═══`);
    resetProcessedTickersIfNewDay();

    const ibNowConnected = isConnected();

    // IB connectivity watchdog: log a warning event when IB drops during market hours
    // so it shows up in Smart Trading → Recent Smart Actions feed.
    if (_ibWasConnected && !ibNowConnected && isMarketHoursET()) {
      log('⚠️  IB Gateway disconnected during market hours — loss cuts and position management are SUSPENDED');
    }
    if (ibNowConnected && !_ibWasConnected) {
      log('IB Gateway reconnected');
    }
    _ibWasConnected = ibNowConnected;

    if (!ibNowConnected) {
      log('IB Gateway not connected — skipping cycle');
      _lastRunResult = 'skipped: IB disconnected';
      return;
    }

    const config = await loadConfig();
    const newEntriesEnabled = config.enabled;

    if (!config.accountId) {
      log('No IB account configured — skipping');
      _lastRunResult = 'skipped: no account';
      return;
    }

    if (!newEntriesEnabled) {
      log('Auto-trading disabled — position management will still run (no new entries)');
    }

    // Get current IB positions (used throughout the cycle)
    const positions = await getEnrichedPositions();

    // 1. Sync positions — detect fills, closes, update P&L
    // Reset pending dollar BEFORE any new orders so IB is source of truth for the full cycle.
    await syncPositions(config, positions);
    _pendingDeployedDollar = 0; // reset after sync — IB is source of truth

    // 2. Save daily portfolio snapshot
    await savePortfolioSnapshotQuiet(config, positions);

    // 3. Update portfolio value from IB positions
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

    // 4. Portfolio health check
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

    // 5. Reconcile orphaned IB positions (once per day)
    // Creates FILLED paper_trade records for IB positions that have no active record,
    // so sell-side modules can manage them even when new entries are disabled.
    await reconcileOrphanedPositions(positions);

    // 6. Position management: dip buy, profit take, loss cut, swing expiry
    // These ALWAYS run regardless of config.enabled — existing positions must be actively managed.
    await checkStaleDayTrades(positions);              // flag/close day trades stuck FILLED from a prior day
    await checkDayTradeTrailingStops(config, positions);       // software trailing stop for day trades in profit (+1R)
    await checkDipBuyOpportunities(config, positions);
    const trimmedTickers = await checkProfitTakeOpportunities(config, positions);
    const lossCutTickers = await checkLossCutOpportunities(config, positions);
    await checkSwingHoldExpiry(config, positions);     // free capital from stale swing trades
    const skipTickers = new Set([...trimmedTickers, ...lossCutTickers]);
    await checkLongTermAutoSell(config, positions, skipTickers);

    // ── New entries below — only run when auto-trading is enabled ─────────────
    if (!newEntriesEnabled) {
      _lastRunResult = 'ok: position management only (new entries disabled)';
      return;
    }

    // 6. Pre-generate Suggested Finds (daily, after market open only)
    // Moved AFTER the market hours gate — belt-and-suspenders to prevent pre-market order placement.
    // Runs after sync+reset so SF trades are tracked in _pendingDeployedDollar for this cycle.
    // Belt-and-suspenders: check BOTH mode_routing AND suggestedFindsEnabled.
    // These can get out of sync if the frontend saves one but not the other.
    if (isModeEnabled(config, 'LONG_TERM') && config.suggestedFindsEnabled !== false) {
      await preGenerateSuggestedFinds(config, positions);
    } else {
      log('Suggested Finds module disabled — skipping');
    }

    // Load scanner ideas FIRST — this calls the trade-scanner edge function (Gemini AI,
    // no Finnhub dependency) and must not be starved by the options scanner's Finnhub usage.
    let allIdeas: TradeIdea[] = [];
    let scannerIdeasLoaded = false;

    const tradeSignalsEnabled = isModeEnabled(config, 'DAY_TRADE') || isModeEnabled(config, 'SWING_TRADE');
    if (!tradeSignalsEnabled) {
      log('Trade Signals module disabled — skipping scanner + video signals');
    } else {
      try {
        const scanStart = Date.now();
        const data = await fetchTradeIdeas();
        const dayCount = (data.dayTrades ?? []).length;
        const swingCount = (data.swingTrades ?? []).length;
        allIdeas = [...(data.dayTrades ?? []), ...(data.swingTrades ?? [])];
        scannerIdeasLoaded = true;
        log(`Trade scanner: ${dayCount} day + ${swingCount} swing ideas (${((Date.now() - scanStart) / 1000).toFixed(1)}s)`);
        if (swingCount > 0) {
          for (const s of data.swingTrades ?? []) {
            log(`  SWING ${s.signal} ${s.ticker} conf=${s.confidence} — ${s.reason}`);
          }
        }
      } catch (err) {
        const msg = `Scanner fetch failed: ${err instanceof Error ? err.message : 'unknown'}`;
        log(msg);
        summaryLog(msg);
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
      // Collect gate results per scan row for UI status badges
      const dayEvals: Record<string, { status: ScanEvaluationStatus; reason: string }> = {};
      const swingEvals: Record<string, { status: ScanEvaluationStatus; reason: string }> = {};
      const recordEval = (idea: TradeIdea, result: string) => {
        const ev = scanResultToEval(result);
        if (idea.mode === 'DAY_TRADE') dayEvals[idea.ticker] = ev;
        else swingEvals[idea.ticker] = ev;
      };

      if (newIdeas.length > 0) {
        const [activeDayCount, activeSwingCount] = await Promise.all([
          countActivePositions('paper', 'DAY_TRADE'),
          countActivePositions('paper', 'SWING_TRADE'),
        ]);
        const daySlots = Math.max(0, config.maxPositions - activeDayCount);
        const swingSlots = Math.max(0, config.maxSwingPositions - activeSwingCount);

        if (daySlots > 0 || swingSlots > 0) {
          const qualifiedDay = newIdeas
            .filter(i => i.mode !== 'SWING_TRADE' && i.confidence >= config.minScannerConfidence)
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, daySlots);
          const qualifiedSwing = newIdeas
            .filter(i => i.mode === 'SWING_TRADE' && i.confidence >= config.minSwingScannerConfidence)
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, swingSlots);
          const qualified = [...qualifiedDay, ...qualifiedSwing];

          for (const idea of qualified) {
            const result = await executeScannerTrade(idea, config, positions);
            log(`  ${idea.ticker}: ${result}`);
            recordEval(idea, result);
            if (!isRetryableSkip(result)) {
              _processedTickers.add(idea.ticker);
            }
            await new Promise(r => setTimeout(r, 2000));
          }
        } else {
          log(`Max positions reached (day: ${config.maxPositions}, swing: ${config.maxSwingPositions}) — skipping scanner ideas`);
          for (const idea of newIdeas) recordEval(idea, 'skipped:max_positions');
        }
      } else if (scannerIdeasLoaded) {
        const msg = allIdeas.length === 0 ? 'No scanner ideas' : `Scanner: ${allIdeas.length} ideas (all filtered or already processed)`;
        log(msg);
        summaryLog(msg);
      }

      // Write evaluation results to DB so the UI can show Armed/Watching/Blocked badges
      if (Object.keys(dayEvals).length > 0)   writeScanEvaluations('day_trades', dayEvals).catch(() => {});
      if (Object.keys(swingEvals).length > 0)  writeScanEvaluations('swing_trades', swingEvals).catch(() => {});
    }

    // 11. SPX key-level breakout-retest scanner (Somesh's strategy)
    // Watches $50 SPX levels for the break → 2 independent candles → retest pattern.
    // Generates a SPY DAY_TRADE order when a clean retest is confirmed.
    // Runs every cycle during market hours; state machine persists in memory across cycles.
    if (tradeSignalsEnabled) try {
      const spxSetups = await checkSpxLevelSetups();
      for (const setup of spxSetups) {
        // Confidence: 9 base. Bump to 9.5 when QQQ confluence is detected
        // (Somesh: multi-instrument confluence raises win probability 58%→92%).
        const hasConfluence = !!setup.confluenceNote;
        const spxConfidence = hasConfluence ? 9.5 : 9;
        if (hasConfluence) log(`[SpxScanner] Confluence boost → confidence ${spxConfidence}: ${setup.confluenceNote}`);

        const idea: TradeIdea = {
          ticker: 'SPY',
          name: 'SPDR S&P 500 ETF Trust',
          price: setup.spyEntry,
          change: 0,
          changePercent: 0,
          signal: setup.signal,
          confidence: spxConfidence,
          reason: setup.description,
          tags: hasConfluence
            ? ['spx_key_level', 'breakout_retest', 'qqq_confluence']
            : ['spx_key_level', 'breakout_retest'],
          mode: 'DAY_TRADE',
          entryPrice: setup.spyEntry,
          stopLoss: setup.spyStop,
          targetPrice: setup.spyTarget,
          riskReward: setup.riskReward,
        };

        if (await hasActiveTrade('SPY', { excludeOptions: true })) {
          log(`[SpxScanner] SPY already has an active trade — skipping level ${setup.spxLevel} setup`);
          continue;
        }
        if (await isDayTradeLossGateActive(config)) {
          log('[SpxScanner] Day-trade loss gate active — skipping SPX setup');
          continue;
        }

        const refreshedPositions = await getEnrichedPositions();
        const result = await executeScannerTrade(idea, config, refreshedPositions);
        log(`[SpxScanner] SPY ${setup.signal} @ ${setup.spxLevel} retest: ${result}`);
        persistEvent('SPY', result.startsWith('executed') ? 'success' : 'skipped',
          `SPX ${setup.spxLevel} retest: ${result}`, {
            source: 'spx_level_scanner',
            spx_level: setup.spxLevel,
            direction: setup.direction,
            ...(setup.confluenceNote && { confluence: setup.confluenceNote }),
          });
      }
    } catch (err) {
      log(`[SpxScanner] Error: ${err instanceof Error ? err.message : 'unknown'}`);
    }

    // 12a-ii. VWAP Confluence scanner — deterministic zone detector
    if (isModeEnabled(config, 'DAY_TRADE')) {
      try {
        await checkVwapConfluenceSetups(async (result: ConfluenceResult) => {
          const idea: TradeIdea = {
            ticker: result.ticker,
            name: result.ticker,
            price: result.entry,
            change: 0,
            changePercent: 0,
            signal: result.signal,
            confidence: result.confidence,
            reason:
              `VWAP confluence: VWAP=$${result.zoneLevels.vwap} EMA8=$${result.zoneLevels.ema8} ` +
              `EMA21=$${result.zoneLevels.ema21} SMA200=$${result.zoneLevels.sma200} ` +
              `(spread ${result.spreadPct}%) → ${result.signal} @ $${result.entry}`,
            tags: ['vwap_confluence'],
            mode: 'DAY_TRADE',
            entryPrice: result.entry,
            stopLoss: result.stop,
            targetPrice: result.target,
            riskReward: result.riskReward,
          };

          if (await hasActiveTrade(result.ticker, { excludeOptions: true })) {
            log(`[VWAPConfluence] ${result.ticker}: already has an active trade — skipping`);
            return;
          }
          if (await isDayTradeLossGateActive(config)) {
            log('[VWAPConfluence] Day-trade loss gate active — skipping');
            return;
          }

          const refreshedPositions = await getEnrichedPositions();
          const execResult = await executeScannerTrade(idea, config, refreshedPositions);
          log(`[VWAPConfluence] ${result.ticker} ${result.signal} @ $${result.entry}: ${execResult}`);
          persistEvent(result.ticker, execResult.startsWith('executed') ? 'success' : 'skipped',
            `VWAP confluence: ${execResult}`, {
              source: 'vwap_confluence_scanner',
              zone_spread_pct: result.spreadPct,
              vwap: result.zoneLevels.vwap,
              ema8: result.zoneLevels.ema8,
              ema21: result.zoneLevels.ema21,
              sma200: result.zoneLevels.sma200,
            });
        });
      } catch (err) {
        log(`[VWAPConfluence] Error: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }

    // 12a-iii. Fibonacci 0.236 retracement rejection scanner
    if (isModeEnabled(config, 'DAY_TRADE')) {
      try {
        await checkFibRetraceSetups(async (result: FibRetraceResult) => {
          const idea: TradeIdea = {
            ticker: result.ticker,
            name: result.ticker,
            price: result.entry,
            change: 0,
            changePercent: 0,
            signal: result.signal,
            confidence: result.confidence,
            reason:
              `Fib 0.236 rejection (${result.trendDirection} trend): ` +
              `swing H=$${result.swingHigh} L=$${result.swingLow} | ` +
              `fib236=$${result.fib236Level} → ${result.signal} @ $${result.entry}`,
            tags: ['fib_236'],
            mode: 'DAY_TRADE',
            entryPrice: result.entry,
            stopLoss: result.stop,
            targetPrice: result.target,
            riskReward: result.riskReward,
          };

          if (await hasActiveTrade(result.ticker, { excludeOptions: true })) {
            log(`[FibRetrace] ${result.ticker}: already has an active trade — skipping`);
            return;
          }
          if (await isDayTradeLossGateActive(config)) {
            log('[FibRetrace] Day-trade loss gate active — skipping');
            return;
          }

          const refreshedPositions = await getEnrichedPositions();
          const execResult = await executeScannerTrade(idea, config, refreshedPositions);
          log(`[FibRetrace] ${result.ticker} ${result.signal} @ $${result.entry}: ${execResult}`);
          persistEvent(result.ticker, execResult.startsWith('executed') ? 'success' : 'skipped',
            `Fib 0.236 rejection: ${execResult}`, {
              source: 'fib_retrace_scanner',
              trend: result.trendDirection,
              swing_high: result.swingHigh,
              swing_low: result.swingLow,
              fib_236: result.fib236Level,
              fib_382: result.fib382Level,
            });
        });
      } catch (err) {
        log(`[FibRetrace] Error: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }

    // 12a-iv. EMA 9/21 pullback scanner — trend + momentum resumption
    if (isModeEnabled(config, 'DAY_TRADE')) {
      try {
        await checkEmaPullbackSetups(async (result: EmaPullbackResult) => {
          const idea: TradeIdea = {
            ticker: result.ticker,
            name: result.ticker,
            price: result.entry,
            change: 0,
            changePercent: 0,
            signal: result.signal,
            confidence: result.confidence,
            reason:
              `9/21 EMA pullback: EMA9=$${result.ema9} EMA21=$${result.ema21} ADX=${result.adx} ` +
              `→ ${result.signal} @ $${result.entry}`,
            tags: ['ema_pullback'],
            mode: 'DAY_TRADE',
            entryPrice: result.entry,
            stopLoss: result.stop,
            targetPrice: result.target,
            riskReward: result.riskReward,
          };

          if (await hasActiveTrade(result.ticker, { excludeOptions: true })) {
            log(`[EMAPullback] ${result.ticker}: already has an active trade — skipping`);
            return;
          }
          if (await isDayTradeLossGateActive(config)) {
            log('[EMAPullback] Day-trade loss gate active — skipping');
            return;
          }

          const refreshedPositions = await getEnrichedPositions();
          const execResult = await executeScannerTrade(idea, config, refreshedPositions);
          log(`[EMAPullback] ${result.ticker} ${result.signal} @ $${result.entry}: ${execResult}`);
          persistEvent(result.ticker, execResult.startsWith('executed') ? 'success' : 'skipped',
            `9/21 EMA pullback: ${execResult}`, {
              source: 'ema_pullback_scanner',
              ema9: result.ema9,
              ema21: result.ema21,
              adx: result.adx,
            });
        });
      } catch (err) {
        log(`[EMAPullback] Error: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }

    // 12b. Penny stock momentum scanner (Ross Cameron's mechanical rules)
    if (!isModeEnabled(config, 'DAY_PENNY')) {
      // silent skip
    } else {
      try {
        const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const etMins = etNow.getHours() * 60 + etNow.getMinutes();
        // Active window: 9:35 AM - 11:30 AM ET (extended to catch later-morning gappers)
        if (etMins >= 9 * 60 + 35 && etMins <= 11 * 60 + 30) {
          if (isPennySessionDone()) {
            log(`[PennyScanner] Session done: ${getPennySessionSummary()}`);
          } else {
            // Step 1: IB scanner for top % gainers in penny price range
            const paperConn = getPaperConnection();
            let ibGainers: IBGainerResult[] = [];
            try {
              ibGainers = await paperConn.scanTopGainers({
                abovePrice: 2,
                belowPrice: 20,
                aboveVolume: 300_000,
                numberOfRows: 25,
              });
              log(`[PennyScanner] IB scan returned ${ibGainers.length} ticker(s): ${ibGainers.map(g => g.ticker).join(', ') || 'none'}`);
            } catch (scanErr) {
              log(`[PennyScanner] IB scan error: ${scanErr instanceof Error ? scanErr.message : 'unknown'}`);
            }

            // Step 2: Enrich with Finnhub and apply Cameron's criteria
            const pennyCandidates = await runPennyDiscovery(ibGainers);

            // Always write scan status to trade_scans so UI shows current state
            {
              const sb = getSupabase();
              const scanData = pennyCandidates.map(c => ({
                ticker: c.ticker,
                name: c.ticker,
                price: c.price,
                change: 0,
                changePercent: c.changePct,
                signal: 'BUY' as const,
                confidence: 8,
                reason: `Penny momentum: +${c.changePct.toFixed(0)}%, ${c.relativeVolume.toFixed(1)}x vol${c.hasCatalyst ? `, catalyst: ${c.catalystHeadline?.slice(0, 60)}` : ''}${c.float ? `, float ${c.float.toFixed(1)}M` : ''}`,
                tags: ['penny_momentum'],
                mode: 'DAY_PENNY' as const,
              }));
              await sb.from('trade_scans').upsert({
                id: 'penny_trades',
                data: scanData,
                scanned_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
              });
            }

            if (pennyCandidates.length > 0) {
              log(`[PennyScanner] Found ${pennyCandidates.length} candidate(s): ${pennyCandidates.map(c => `${c.ticker}(+${c.changePct.toFixed(0)}%)`).join(', ')}`);

              // Check entry signals and execute
              const pennySession = getPennySessionState();
              const activeCount = await countActivePositions();
              const slots = config.maxPositions - activeCount;

              for (const candidate of pennyCandidates) {
                if (slots <= 0) break;
                if (pennySession.done) break;
                if (await hasActiveTrade(candidate.ticker, { excludeOptions: true })) continue;

                const entry = await checkPennyEntry(candidate);
                if (!entry) continue;

                const posSize = pennyPositionSize(config);
                const qty = Math.max(1, Math.floor(posSize / entry.entryPrice));
                if (qty <= 0) continue;

                log(`[PennyScanner] Entry signal: ${candidate.ticker} @ $${entry.entryPrice.toFixed(2)}, stop $${entry.stopLoss.toFixed(2)}, target $${entry.targetPrice.toFixed(2)}, R:R ${entry.riskReward.toFixed(1)}`);

                try {
                  const orderResult = await placeBracketOrder({
                    symbol: candidate.ticker,
                    side: 'BUY',
                    quantity: qty,
                    entryPrice: entry.entryPrice,
                    stopLoss: entry.stopLoss,
                    takeProfit: entry.targetPrice,
                    tif: 'DAY',
                  });

                  await createPaperTrade({
                    ticker: candidate.ticker,
                    mode: 'DAY_PENNY',
                    signal: 'BUY',
                    entry_price: entry.entryPrice,
                    stop_loss: entry.stopLoss,
                    target_price: entry.targetPrice,
                    risk_reward: `${entry.riskReward.toFixed(1)}:1`,
                    quantity: qty,
                    position_size: qty * entry.entryPrice,
                    status: 'SUBMITTED',
                    ib_order_id: String(orderResult.parentOrderId),
                    ib_parent_order_id: String(orderResult.parentOrderId),
                    ib_tp_order_id: String(orderResult.takeProfitOrderId),
                    ib_sl_order_id: String(orderResult.stopLossOrderId),
                    scanner_reason: `Penny momentum: +${candidate.changePct.toFixed(0)}%, pullback #${entry.pullbackNumber}, MACD hist ${entry.macdHistogram.toFixed(4)}`,
                    notes: `Penny trade #${pennySession.totalTrades + 1} of day. Session: ${getPennySessionSummary()}`,
                    opened_at: new Date().toISOString(),
                  });

                  persistEvent(candidate.ticker, 'success',
                    `Penny BUY: ${qty} shares @ $${entry.entryPrice.toFixed(2)}, R:R ${entry.riskReward.toFixed(1)}:1`, {
                      source: 'penny_scanner',
                      mode: 'DAY_PENNY',
                    });

                  log(`[PennyScanner] Executed: ${candidate.ticker} ${qty} shares @ $${entry.entryPrice.toFixed(2)}`);
                } catch (err) {
                  log(`[PennyScanner] Order failed for ${candidate.ticker}: ${err instanceof Error ? err.message : 'unknown'}`);
                  persistEvent(candidate.ticker, 'error',
                    `Penny order failed: ${err instanceof Error ? err.message : 'unknown'}`, {
                      source: 'penny_scanner',
                      mode: 'DAY_PENNY',
                    });
                }
              }
            } else {
              log('[PennyScanner] No candidates found this cycle');
            }

            // Exit monitoring for open penny positions
            const activeTrades = await getActiveTrades();
            const pennyTrades = activeTrades.filter(t => t.mode === 'DAY_PENNY' && t.status === 'FILLED');
            for (const trade of pennyTrades) {
              const exitSignal = await checkPennyExit(trade.ticker, trade.entry_price ?? 0);
              if (exitSignal) {
                log(`[PennyScanner] Exit signal for ${trade.ticker}: ${exitSignal.reasons.join(', ')}`);
                try {
                  const closeSide = 'SELL';
                  const qty = trade.quantity ?? 0;
                  if (qty > 0) {
                    const fillResult = await placeMarketOrder({ symbol: trade.ticker, side: closeSide, quantity: qty });
                    await recordTradeClose({
                      tradeId: trade.id,
                      closePrice: fillResult.avgFillPrice,
                      closeReason: 'penny_exit',
                      status: 'CLOSED',
                      orderId: fillResult.orderId,
                      accountType: 'paper',
                      extraUpdates: { notes: `${trade.notes ?? ''} | Exit: ${exitSignal.reasons.join(', ')}` },
                    });
                    persistEvent(trade.ticker, 'success',
                      `Penny exit: ${exitSignal.reasons.join(', ')} — fill $${fillResult.avgFillPrice.toFixed(2)}`, {
                        source: 'penny_scanner',
                        mode: 'DAY_PENNY',
                      });
                  }
                } catch (err) {
                  log(`[PennyScanner] Exit failed for ${trade.ticker}: ${err instanceof Error ? err.message : 'unknown'}`);
                }
              }
            }
          }
        }
      } catch (err) {
        log(`[PennyScanner] Error: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }

    // 13. Options wheel — manage open positions (every cycle, 30-min intervals)
    const optionsWheelEnabled = isModeEnabled(config, 'OPTIONS_PUT') || isModeEnabled(config, 'OPTIONS_CALL') || isModeEnabled(config, 'CREDIT_SPREAD') || isModeEnabled(config, 'CALENDAR_SPREAD');
    if (!optionsWheelEnabled) {
      log('Options Wheel module disabled — skipping management + scan');
    } else {
    try {
      const optsMgr = await runOptionsManageCycle();
      if (optsMgr.closed50Pct.length > 0) log(`Options: closed at ${optsMgr.profitClosePct}% profit — ${optsMgr.closed50Pct.join(', ')}`);
      if (optsMgr.rollAlerts.length > 0) log(`Options: roll/close alerts — ${optsMgr.rollAlerts.join(', ')}`);
      if (optsMgr.assignmentAlerts.length > 0) log(`Options: assignment risk — ${optsMgr.assignmentAlerts.join(', ')}`);
      if (optsMgr.stopLossAlerts.length > 0) {
        for (const ticker of optsMgr.stopLossAlerts) {
          await sendAlert(
            'stop_loss',
            `🛑 Options Stop-Loss Triggered: ${ticker}`,
            `An options position stop-loss was triggered for ${ticker}.

The premium exceeded ${optsMgr.stopLossMultiplier}× the original collected — the position was closed automatically to protect capital.

Check the Options Wheel → History tab for details.`,
            ticker,
          );
        }
      }
      if (optsMgr.assignmentAlerts.length > 0) {
        for (const ticker of optsMgr.assignmentAlerts) {
          await sendAlert(
            'assignment',
            `📌 Options Assignment Detected: ${ticker}`,
            `A put option assignment was detected for ${ticker}.

Stock price dropped below the put strike. A covered call has been automatically queued.

Check the Options Wheel → Open tab to review the covered call position.`,
            ticker,
          );
        }
      }
    } catch (err) {
      log(`Options manager error: ${err instanceof Error ? err.message : 'unknown'}`);
    }

    // 14. Options wheel — full-day scan (10:00 AM – 3:30 PM ET)
    //
    // Expanded from morning-only to catch dislocations throughout the entire session.
    // The VIX-spike + 200 DMA signal we target can trigger at ANY time, not just at open.
    //
    // Cadence (to avoid hammering Finnhub unnecessarily):
    //   Morning   10:00 – 11:30 AM  → every 15 min (high IV, earnings reactions, gap fills)
    //   Midday    11:30 AM – 2:00 PM → every 30 min (news-driven drops, sector rotations)
    //   Afternoon  2:00 – 3:30 PM  → every 30 min (late-session dislocations, pre-close IV)
    //
    // Daily new-position cap: max OPTIONS_MAX_NEW_PER_DAY new puts per calendar day.
    // Prevents over-deploying capital on a single down-day even across multiple scan windows.
    // Existing positions continue to be managed regardless of this cap.
    const OPTIONS_MAX_NEW_PER_DAY = 3;

    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const etHour = nowET.getHours();
    const etMin  = nowET.getMinutes();

    // Determine which cadence applies for this cycle
    const isMorningSession  = etHour === 10 || (etHour === 11 && etMin < 30);
    const isMiddaySession   = (etHour === 11 && etMin >= 30) || etHour === 12 || (etHour === 13 && etMin < 60);
    const isAfternoonSession = etHour === 14 || (etHour === 15 && etMin < 30);

    // 30-min cadence: fire only on the :00 or :30 passes within the 15-min main cycle
    const isOnThirtyMinMark = etMin < 15 || (etMin >= 30 && etMin < 45);

    const shouldScan = isMorningSession || ((isMiddaySession || isAfternoonSession) && isOnThirtyMinMark);

    if (shouldScan) {
      try {
        const sb = getSupabase();
        const optionsCapitalBudget = (config.maxTotalAllocation != null && config.maxTotalAllocation >= 1000)
          ? config.maxTotalAllocation
          : config.portfolioValue * 0.5;

        // ── Daily new-position cap ────────────────────────────────────────────
        // Count puts opened since midnight ET today (any status — even PENDING counts
        // to prevent queuing duplicates if IB is slow to confirm).
        const todayStart = new Date(nowET.getFullYear(), nowET.getMonth(), nowET.getDate()).toISOString();
        const { data: openedToday } = await sb
          .from('paper_trades')
          .select('id')
          .eq('mode', 'OPTIONS_PUT')
          .gte('created_at', todayStart)
          .in('status', [...ACTIVE_STATUSES]);
        const newPositionsToday = (openedToday ?? []).length;

        if (newPositionsToday >= OPTIONS_MAX_NEW_PER_DAY) {
          log(`Options scan: daily cap reached (${newPositionsToday}/${OPTIONS_MAX_NEW_PER_DAY} new puts today) — skipping new entries`);
        } else {
          // ── Monthly loss circuit-breaker ──────────────────────────────────
          // If options P&L for the current calendar month is below -5% of the options budget,
          // pause all new positions until the next month.
          const MONTHLY_LOSS_CAP_PCT = 0.05;
          const monthStart = new Date(nowET.getFullYear(), nowET.getMonth(), 1).toISOString();
          const { data: monthlyPnlRows } = await sb
            .from('paper_trades')
            .select('pnl')
            .in('mode', ['OPTIONS_PUT', 'OPTIONS_CALL'])
            .not('pnl', 'is', null)
            .gte('closed_at', monthStart);
          const monthlyPnl = (monthlyPnlRows ?? []).reduce((s: number, r: { pnl: number | null }) => s + (r.pnl ?? 0), 0);
          const monthlyLossCap = -(optionsCapitalBudget * MONTHLY_LOSS_CAP_PCT);

          if (monthlyPnl < monthlyLossCap) {
            log(`⚠️  Options: monthly loss circuit-breaker triggered — P&L $${monthlyPnl.toFixed(0)} below cap $${monthlyLossCap.toFixed(0)}. No new positions until next month.`);
            await sendAlert(
              'circuit_breaker',
              '🚨 Options Monthly Loss Circuit-Breaker Triggered',
              `The options wheel monthly loss circuit-breaker has been triggered.

Monthly P&L: $${monthlyPnl.toFixed(0)}
Loss cap: $${monthlyLossCap.toFixed(0)}

No new options positions will be opened until next month. Existing positions continue to be managed.`,
            );
          } else {
            const { enabled: autoEnabled, maxContracts: maxNewPerScan } = await import('./lib/options-scanner.js').then(m => m.getOptionsAutoTradeConfig());
            if (!autoEnabled) {
              log('Options auto-trade disabled — skipping scan');
            } else {
              const slotsRemaining = OPTIONS_MAX_NEW_PER_DAY - newPositionsToday;
              const sessionTag = isMorningSession ? 'morning' : isMiddaySession ? 'midday' : 'afternoon';
              const scanResult = await runOptionsScan(optionsCapitalBudget);

              if (scanResult.opportunities.length > 0) {
                const toPlace = Math.min(maxNewPerScan, slotsRemaining);
                log(`Options ${sessionTag} scan: ${scanResult.opportunities.length} opps — placing up to ${toPlace} (${newPositionsToday}/${OPTIONS_MAX_NEW_PER_DAY} today, monthly P&L: $${monthlyPnl.toFixed(0)})`);
                for (const opp of scanResult.opportunities.slice(0, toPlace)) {
                  const result = await autoTradeOption(opp);
                  const tag = result.isLive ? `IB order #${result.ibOrderId}` : 'paper fallback (IB offline)';
                  if (result.tradeId) log(`  → ${opp.ticker} $${opp.strike}P @ $${opp.premium.toFixed(2)} (${opp.annualYield.toFixed(1)}% ann.) — ${tag}`);
                }
              } else {
                log(`Options ${sessionTag} scan: no opportunities (${scanResult.skipped.length} checked, ${newPositionsToday}/${OPTIONS_MAX_NEW_PER_DAY} today)`);
                for (const s of scanResult.skipped) log(`  ✗ ${s.ticker}: ${s.reason}`);
              }
            }
          }
        }
      } catch (err) {
        log(`Options scan error: ${err instanceof Error ? err.message : 'unknown'}`);
      }
      // Drain delay: let IB Gateway clear any pending responses before next cycle's
      // day-trade contract lookups. Prevents no_contract failures after heavy scans.
      await new Promise(r => setTimeout(r, 5_000));
    }
    } // end optionsWheelEnabled (derived from mode routing)

    // 15. Daily rehydration (after 4:15 PM ET)
    await runDailyRehydration(config);

    // 16. Pre-warm position price cache so the next page load is instant.
    // Runs in background — cycle timing not affected.
    const { requestPositions } = await import('./ib-connection.js');
    requestPositions().then(async (posData) => {
      const symbols = [...new Set(posData.filter(p => p.position !== 0 && p.secType !== 'OPT').map(p => p.symbol))];
      if (symbols.length > 0) warmPositionPriceCache(symbols).catch(() => {});
    }).catch(() => {}); // non-blocking

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
