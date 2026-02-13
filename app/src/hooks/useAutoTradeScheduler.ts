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
  processTradeIdeas,
} from '../lib/autoTrader';
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
      const config = getAutoTraderConfig();
      if (!config.enabled) return;
      if (!isMarketHoursET()) return;

      // Throttle: don't run more than once per 15 minutes
      const now = Date.now();
      if (now - lastRunRef.current < 15 * 60 * 1000) return;
      lastRunRef.current = now;

      try {
        console.log('[AutoTradeScheduler] Background scanner check running...');
        const data = await fetchTradeIdeas();

        const allIdeas = [...(data.dayTrades ?? []), ...(data.swingTrades ?? [])];
        const newIdeas = allIdeas.filter(i => !processedTickersRef.current.has(i.ticker));

        if (newIdeas.length === 0) return;

        // Mark as processed
        newIdeas.forEach(i => processedTickersRef.current.add(i.ticker));

        await processTradeIdeas(newIdeas, config);
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
