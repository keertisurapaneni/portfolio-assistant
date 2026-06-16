/**
 * Live trading control endpoints:
 *   POST /api/live/kill-switch — engage/disengage the live kill switch
 *   GET  /api/live/status      — live connection status, P&L, positions
 *   GET  /api/live/mode-routing — current mode→account routing config
 *   PUT  /api/live/mode-routing — update mode→account routing
 */

import { Router } from 'express';
import { getLiveConnection, getPaperConnection } from '../ib-connection.js';
import { loadConfig, saveConfigPartial } from '../lib/supabase.js';
import type { RouteTarget } from '../../../shared/trade-types.js';

const router = Router();

router.post('/live/kill-switch', async (req, res) => {
  try {
    const { engage } = req.body as { engage?: boolean };
    if (typeof engage !== 'boolean') {
      res.status(400).json({ error: 'Missing required boolean field: engage' });
      return;
    }

    await saveConfigPartial({ liveKillSwitch: engage });

    const liveConn = getLiveConnection();
    if (engage && liveConn.isConnected()) {
      liveConn.disconnect();
    }

    res.json({ ok: true, liveKillSwitch: engage });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' });
  }
});

router.get('/live/status', async (_req, res) => {
  try {
    const config = await loadConfig();
    const liveConn = getLiveConnection();
    const paperConn = getPaperConnection();

    res.json({
      liveKillSwitch: config.liveKillSwitch ?? false,
      live: {
        connected: liveConn.isConnected(),
        accounts: liveConn.getAccounts(),
        defaultAccount: liveConn.getDefaultAccount(),
        pnl: liveConn.isConnected() ? liveConn.getDailyPnL() : null,
      },
      paper: {
        connected: paperConn.isConnected(),
        accounts: paperConn.getAccounts(),
        defaultAccount: paperConn.getDefaultAccount(),
        pnl: paperConn.isConnected() ? paperConn.getDailyPnL() : null,
      },
      modeRouting: config.modeRouting ?? {},
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' });
  }
});

router.get('/live/mode-routing', async (_req, res) => {
  try {
    const config = await loadConfig();
    res.json({ modeRouting: config.modeRouting ?? {} });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' });
  }
});

router.put('/live/mode-routing', async (req, res) => {
  try {
    const { modeRouting } = req.body as { modeRouting?: Record<string, RouteTarget> };
    if (!modeRouting || typeof modeRouting !== 'object') {
      res.status(400).json({ error: 'Missing required object field: modeRouting' });
      return;
    }

    const validModes = [
      'DAY_TRADE', 'DAY_PENNY', 'SWING_TRADE', 'LONG_TERM',
      'OPTIONS_PUT', 'OPTIONS_CALL',
      'CREDIT_SPREAD', 'EARNINGS_CALENDAR',
    ];
    const validTargets: RouteTarget[] = ['off', 'paper', 'live', 'both'];
    for (const [mode, target] of Object.entries(modeRouting)) {
      if (!validModes.includes(mode)) {
        res.status(400).json({ error: `Invalid mode: ${mode}` });
        return;
      }
      if (!validTargets.includes(target)) {
        res.status(400).json({ error: `Invalid route target for ${mode}: ${target}` });
        return;
      }
    }

    await saveConfigPartial({ mode_routing: modeRouting });
    res.json({ ok: true, modeRouting });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' });
  }
});

export default router;
