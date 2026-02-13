/**
 * Background auto-trade scheduler — runs scanner + suggested finds
 * processing on a schedule regardless of which page is open.
 *
 * Mounted at the app level (App.tsx) so it runs as long as the browser tab is open.
 *
 * Schedule:
 *   - Scanner: twice daily during market hours (~10:00 AM and 3:30 PM ET)
 *   - Suggested Finds: once on mount (if not already processed this session)
 *
 * The edge function caches results, so calling it doesn't trigger unnecessary re-scans.
 */

import { useEffect, useRef } from 'react';
import { fetchTradeIdeas } from '../lib/tradeScannerApi';
import {
  getAutoTraderConfig,
  loadAutoTraderConfig,
  processTradeIdeas,
  syncPositions,
} from '../lib/autoTrader';
import { getPositions } from '../lib/ibClient';
import { savePortfolioSnapshot, getActiveTrades } from '../lib/paperTradesApi';
import { useAuth } from '../lib/auth';

/** Check if we're in US market hours (9:30 AM - 4:00 PM ET, weekdays) */
function isMarketHoursET(): boolean {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
}

/** Interval between scanner checks (30 minutes) */
const SCANNER_INTERVAL_MS = 30 * 60 * 1000;

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

export function useAutoTradeScheduler() {
  const { user } = useAuth();
  const isAuthed = !!user;
  const processedTickersRef = useRef<Set<string>>(new Set());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastRunRef = useRef<number>(0);

  useEffect(() => {
    // Only run if authenticated
    if (!isAuthed) return;

    const runScannerAutoTrade = async () => {
      // Load fresh config from Supabase (in case settings changed from another tab/device)
      const config = await loadAutoTraderConfig();
      if (!config.enabled) return;
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

          // Save daily portfolio snapshot (non-blocking)
          savePortfolioSnapshotQuiet(config.accountId).catch(() => {});
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
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isAuthed]);
}
