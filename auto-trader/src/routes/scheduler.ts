/**
 * Scheduler REST API — status, control, and manual trigger.
 *
 * GET  /api/scheduler/status — current scheduler state
 * POST /api/scheduler/run    — trigger manual cycle
 * POST /api/scheduler/stop   — stop the cron scheduler
 * POST /api/scheduler/start  — start the cron scheduler
 */

import { Router } from 'express';
import {
  getSchedulerStatus,
  triggerManualRun,
  forceExecuteSignal,
  startScheduler,
  stopScheduler,
} from '../scheduler.js';

const router = Router();

router.get('/scheduler/status', (_req, res) => {
  res.json(getSchedulerStatus());
});

router.post('/scheduler/run', async (_req, res) => {
  const result = await triggerManualRun();
  res.json({ result });
});

router.post('/scheduler/execute-signal', async (req, res) => {
  const { signal_id } = req.body ?? {};
  if (!signal_id || typeof signal_id !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing signal_id' });
  }
  try {
    const out = await forceExecuteSignal(signal_id);
    if (!out.ok) return res.status(400).json(out);
    res.json(out);
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

router.post('/scheduler/start', (_req, res) => {
  startScheduler();
  res.json(getSchedulerStatus());
});

router.post('/scheduler/stop', (_req, res) => {
  stopScheduler();
  res.json(getSchedulerStatus());
});

export default router;
