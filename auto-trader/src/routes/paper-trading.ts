/**
 * GET /api/paper-trading/performance
 * Returns performance summary for UI. Cached 60s.
 */

import { Router } from 'express';
import { getPerformanceForWindow, type WindowKey } from '../lib/tradePerformanceMetrics.js';

const router = Router();

const CACHE_MS = 60 * 1000;
let _cache: {
  window: string;
  data: Awaited<ReturnType<typeof getPerformanceForWindow>>;
  ts: number;
} | null = null;

router.get('/paper-trading/performance', async (req, res) => {
  const window = (req.query.window as string) || '30d';
  const validWindow = ['7d', '30d', '90d'].includes(window) ? (window as WindowKey) : '30d';

  if (_cache && _cache.window === validWindow && Date.now() - _cache.ts < CACHE_MS) {
    return res.json(_cache.data);
  }

  try {
    const data = await getPerformanceForWindow(validWindow);
    _cache = { window: validWindow, data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    console.error('[paper-trading/performance]:', err);
    res.status(500).json({
      asOf: new Date().toISOString(),
      overall: {
        count_trades_closed: 0,
        win_rate: 0,
        avg_return_pct: 0,
        median_return_pct: 0,
        stdev_return_pct: 0,
        profit_factor: 0,
        avg_days_held: 0,
        total_pnl: 0,
        portfolio_realized_return_pct: 0,
      },
      byStrategy: {},
      byTag: {},
      byRegime: {},
      recentClosedTrades: [],
      warnings: [err instanceof Error ? err.message : 'Failed to load performance'],
    });
  }
});

export default router;
