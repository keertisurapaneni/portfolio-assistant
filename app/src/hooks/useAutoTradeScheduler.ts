/**
 * Background auto-trade scheduler — defers to the server-side scheduler
 * running inside the auto-trader service (node-cron, no browser needed).
 *
 * The browser hook now:
 *   1. Checks if the server scheduler is active (GET /api/scheduler/status)
 *   2. If yes → does nothing (server handles everything)
 *   3. If no → falls back to browser-side scheduling as before
 *
 * This means trades happen even when no browser tab is open, as long as
 * the auto-trader service + IB Gateway are running.
 */

import { useEffect, useRef } from 'react';
import { fetchTradeIdeas } from '../lib/tradeScannerApi';
import {
  loadAutoTraderConfig,
  saveAutoTraderConfig,
  processTradeIdeas,
  processSuggestedFinds,
  syncPositions,
  checkDipBuyOpportunities,
  checkProfitTakeOpportunities,
  checkLossCutOpportunities,
  resetPendingOrders,
  assessPortfolioHealth,
  resetHealthCache,
} from '../lib/autoTrader';
import { getPositions } from '../lib/ibClient';
import {
  savePortfolioSnapshot,
  getActiveTrades,
  recalculatePerformance,
  recalculatePerformanceByCategory,
} from '../lib/paperTradesApi';
import { analyzeUnreviewedTrades, updatePerformancePatterns } from '../lib/aiFeedback';
import { discoverStocks } from '../lib/aiSuggestedFinds';
import { useAuth } from '../lib/auth';

const SCHEDULER_CHECK_BACKOFF_MS = 5 * 60 * 1000; // 5 min after failure
let _lastSchedulerCheckFail = 0;

async function isServerSchedulerRunning(): Promise<boolean> {
  if (Date.now() - _lastSchedulerCheckFail < SCHEDULER_CHECK_BACKOFF_MS) {
    return false; // Recently failed, avoid repeated 404s
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch('http://localhost:3001/api/scheduler/status', { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) {
      _lastSchedulerCheckFail = Date.now();
      return false;
    }
    const data = await res.json();
    return data.running === true;
  } catch {
    _lastSchedulerCheckFail = Date.now();
    return false;
  }
}

/** Check if we're in US market hours (9:30 AM - 4:00 PM ET, weekdays) */
function isMarketHoursET(): boolean {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
}

/** Interval between scanner checks (15 minutes, matches server scheduler) */
const SCANNER_INTERVAL_MS = 15 * 60 * 1000;

/** Save a portfolio snapshot — called once per sync cycle */
let _lastSnapshotDate = '';
async function savePortfolioSnapshotQuiet(accountId: string) {
  const today = new Date().toISOString().slice(0, 10);
  if (_lastSnapshotDate === today) return; // Already saved today

  try {
    const [positions, activeTrades] = await Promise.all([
      getPositions(accountId),
      getActiveTrades(),
    ]);

    if (positions.length === 0) return;

    const posData = positions.map(p => ({
      ticker: p.contractDesc,
      qty: p.position,
      avgCost: p.avgPrice,
      mktPrice: p.mktPrice ?? 0,
      mktValue: p.mktValue ?? 0,
      unrealizedPnl: p.unrealizedPnl ?? 0,
    }));

    const totalValue = posData.reduce((sum, p) => sum + Math.abs(p.mktValue), 0);
    const totalPnl = posData.reduce((sum, p) => sum + p.unrealizedPnl, 0);

    await savePortfolioSnapshot({
      accountId,
      totalValue,
      totalPnl,
      positions: posData,
      openTradeCount: activeTrades.length,
    });

    _lastSnapshotDate = today;
    console.log('[AutoTradeScheduler] Portfolio snapshot saved');
  } catch (err) {
    console.warn('[AutoTradeScheduler] Snapshot failed:', err);
  }
}

/** Check if it's past 4:15 PM ET (post-market close) */
function isPastMarketCloseET(): boolean {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 16 * 60 + 15;
}

/** Pre-generate Suggested Finds + auto-trade qualifying picks — once daily at ~9 AM ET */
let _lastSuggestedFindsDate = '';
async function preGenerateSuggestedFinds() {
  const today = new Date().toISOString().slice(0, 10);
  if (_lastSuggestedFindsDate === today) return;

  // Only run around 9 AM ET (between 8:55 and 9:30 AM ET, or later if first check of the day)
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = et.getHours() * 60 + et.getMinutes();
  // Run if it's 9 AM+ ET and we haven't run today yet
  if (mins < 9 * 60) return;

  try {
    console.log('[AutoTradeScheduler] Pre-generating Suggested Finds for today...');
    // discoverStocks with forceRefresh=false — uses server cache if available,
    // otherwise generates fresh and caches for all users
    const result = await discoverStocks([], false);
    console.log(
      `[AutoTradeScheduler] Suggested Finds ready: ${result.compounders.length} compounders, ${result.goldMines.length} gold mines`
    );

    // Auto-trade qualifying Suggested Finds
    const config = await loadAutoTraderConfig();
    if (config.enabled && config.accountId) {
      const allStocks = [...result.compounders, ...result.goldMines];

      // Identify top picks (first in each list with conviction 8+)
      const topPickTickers = new Set<string>();
      const firstCompounder = result.compounders[0];
      const firstGoldMine = result.goldMines[0];
      if (firstCompounder && (firstCompounder.conviction ?? 0) >= 8) topPickTickers.add(firstCompounder.ticker);
      if (firstGoldMine && (firstGoldMine.conviction ?? 0) >= 8) topPickTickers.add(firstGoldMine.ticker);

      const results = await processSuggestedFinds(allStocks, config, topPickTickers);
      const executed = results.filter(r => r.action === 'executed');
      if (executed.length > 0) {
        console.log(`[AutoTradeScheduler] Auto-traded ${executed.length} Suggested Finds: ${executed.map(r => r.ticker).join(', ')}`);
      }
    }

    _lastSuggestedFindsDate = today;
  } catch (err) {
    console.warn('[AutoTradeScheduler] Suggested Finds pre-generation failed:', err);
  }
}

/** Daily rehydration — run once per day after market close */
let _lastRehydrationDate = '';
async function runDailyRehydration(accountId: string) {
  const today = new Date().toISOString().slice(0, 10);
  if (_lastRehydrationDate === today) return;
  if (!isPastMarketCloseET()) return;

  try {
    console.log('[AutoTradeScheduler] Running daily rehydration...');
    await syncPositions(accountId);
    await recalculatePerformance();
    await recalculatePerformanceByCategory();
    const analyzed = await analyzeUnreviewedTrades();
    if (analyzed > 0) {
      await updatePerformancePatterns();
      console.log(`[AutoTradeScheduler] Analyzed ${analyzed} unreviewed trades`);
    }
    _lastRehydrationDate = today;
    console.log('[AutoTradeScheduler] Daily rehydration complete');
  } catch (err) {
    console.warn('[AutoTradeScheduler] Rehydration failed:', err);
  }
}

export function useAutoTradeScheduler() {
  const { user } = useAuth();
  const isAuthed = !!user;
  const processedTickersRef = useRef<Set<string>>(new Set());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastRunRef = useRef<number>(0);
  const serverSchedulerRef = useRef<boolean>(false);

  useEffect(() => {
    if (!isAuthed) return;

    // Check if the server-side scheduler is handling things
    isServerSchedulerRunning().then(running => {
      serverSchedulerRef.current = running;
      if (running) {
        console.log('[AutoTradeScheduler] Server-side scheduler is active — browser scheduling disabled');
      } else {
        console.log('[AutoTradeScheduler] Server scheduler not detected — using browser fallback');
      }
    });

    // Re-check every 5 minutes in case server starts/stops
    const serverCheckInterval = setInterval(() => {
      isServerSchedulerRunning().then(running => {
        if (running !== serverSchedulerRef.current) {
          serverSchedulerRef.current = running;
          console.log(`[AutoTradeScheduler] Server scheduler ${running ? 'now active' : 'stopped'} — ${running ? 'browser scheduling disabled' : 'browser fallback active'}`);
        }
      });
    }, 5 * 60 * 1000);

    const runScannerAutoTrade = async () => {
      // If server scheduler is running, skip browser-side scheduling entirely
      if (serverSchedulerRef.current) return;
      // Load fresh config from Supabase (in case settings changed from another tab/device)
      const config = await loadAutoTraderConfig();
      if (!config.enabled) return;

      // Pre-generate Suggested Finds daily at 9 AM ET (runs before market open)
      // IMPORTANT: Await this — do NOT fire-and-forget, otherwise it races with
      // scanner processing and both check the allocation cap against stale IB data.
      try {
        await preGenerateSuggestedFinds();
      } catch (err) {
        console.warn('[AutoTradeScheduler] Suggested Finds pre-generation failed:', err);
      }

      if (!isMarketHoursET()) return;

      // Throttle: don't run more than once per 15 minutes
      const now = Date.now();
      if (now - lastRunRef.current < 15 * 60 * 1000) return;
      lastRunRef.current = now;

      try {
        console.log('[AutoTradeScheduler] Background scanner check running...');
        const data = await fetchTradeIdeas();

        // Always sync positions first — detect fills, closes, and update P&L
        if (config.accountId) {
          await syncPositions(config.accountId);
          // IB positions are now up-to-date — reset pending order tracker
          resetPendingOrders();

          // Save daily portfolio snapshot (non-blocking)
          savePortfolioSnapshotQuiet(config.accountId).catch(() => {});

          // Update portfolio value from IB positions
          try {
            const positions = await getPositions(config.accountId);
            if (positions.length > 0) {
              const totalMktValue = positions.reduce(
                (sum, p) => sum + Math.abs(p.position) * (p.mktPrice > 0 ? p.mktPrice : p.avgCost), 0
              );
              if (totalMktValue > 0) {
                // Include cash estimate (portfolio - positions)
                const pv = Math.max(totalMktValue, config.portfolioValue);
                if (Math.abs(pv - config.portfolioValue) > 1000) {
                  await saveAutoTraderConfig({ portfolioValue: pv });
                  console.log(`[AutoTradeScheduler] Portfolio value updated: $${pv.toLocaleString()}`);
                }
              }
            }

            // Portfolio health check — logs status + sets drawdown multiplier
            resetHealthCache(); // force fresh check with latest positions
            const health = await assessPortfolioHealth(config);
            if (health.drawdownLevel !== 'normal') {
              console.log(`[AutoTradeScheduler] Drawdown protection: ${health.drawdownLevel} (${health.totalUnrealizedPnlPct.toFixed(1)}%, multiplier: ${health.drawdownMultiplier})`);
            }

            // Layer 2 & 3: Dip buying, profit taking, loss cutting
            await checkDipBuyOpportunities(config, positions);
            await checkProfitTakeOpportunities(config, positions);
            await checkLossCutOpportunities(config, positions);
          } catch (err) {
            console.warn('[AutoTradeScheduler] Smart trading checks failed:', err);
          }

          // Mid-day analysis: run performance analysis during market hours too
          // (not just after close) so we can learn faster
          try {
            const analyzed = await analyzeUnreviewedTrades();
            if (analyzed > 0) {
              await updatePerformancePatterns();
              console.log(`[AutoTradeScheduler] Mid-day analysis: ${analyzed} trades reviewed`);
            }
          } catch { /* non-critical */ }

          // Daily rehydration (after 4:15 PM ET)
          runDailyRehydration(config.accountId).catch(() => {});
        }

        const allIdeas = [...(data.dayTrades ?? []), ...(data.swingTrades ?? [])];
        const newIdeas = allIdeas.filter(i => !processedTickersRef.current.has(i.ticker));

        if (newIdeas.length > 0) {
          // Mark as processed
          newIdeas.forEach(i => processedTickersRef.current.add(i.ticker));
          await processTradeIdeas(newIdeas, config);
        }
      } catch (err) {
        console.error('[AutoTradeScheduler] Scanner check failed:', err);
      }
    };

    // Run once shortly after mount (5s delay to let app settle)
    const initTimeout = setTimeout(runScannerAutoTrade, 5_000);

    // Then run on interval
    intervalRef.current = setInterval(runScannerAutoTrade, SCANNER_INTERVAL_MS);

    return () => {
      clearTimeout(initTimeout);
      clearInterval(serverCheckInterval);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isAuthed]);
}
