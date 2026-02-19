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

router.post('/scheduler/start', (_req, res) => {
  startScheduler();
  res.json(getSchedulerStatus());
});

router.post('/scheduler/stop', (_req, res) => {
  stopScheduler();
  res.json(getSchedulerStatus());
});

export default router;
