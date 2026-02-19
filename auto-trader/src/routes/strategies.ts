/**
 * Strategy routes:
 * - Queue externally sourced trade signals (date/time based)
 * - Inspect queued signals
 * - Track source-level P&L performance
 */

import { Router } from 'express';
import {
  createExternalStrategySignal,
  getExternalStrategySignals,
  getStrategySourcePerformance,
  updateExternalStrategySignal,
  type ExternalStrategySignalStatus,
} from '../lib/supabase.js';

const router = Router();

const VALID_SIGNALS = new Set(['BUY', 'SELL']);
const VALID_MODES = new Set(['DAY_TRADE', 'SWING_TRADE', 'LONG_TERM']);
const VALID_STATUSES = new Set(['PENDING', 'EXECUTED', 'FAILED', 'SKIPPED', 'EXPIRED', 'CANCELLED']);

function parseOptionalNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

router.get('/strategy-signals', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 100)));
    const rawStatus = String(req.query.status ?? '').toUpperCase();
    const status = rawStatus && VALID_STATUSES.has(rawStatus)
      ? rawStatus as ExternalStrategySignalStatus
      : undefined;
    const signals = await getExternalStrategySignals(limit, status);
    res.json({ signals });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load strategy signals' });
  }
});

router.post('/strategy-signals', async (req, res) => {
  try {
    const sourceName = String(req.body?.sourceName ?? '').trim();
    const sourceUrl = req.body?.sourceUrl ? String(req.body.sourceUrl).trim() : null;
    const strategyVideoId = req.body?.strategyVideoId ? String(req.body.strategyVideoId).trim() : null;
    const strategyVideoHeading = req.body?.strategyVideoHeading ? String(req.body.strategyVideoHeading).trim() : null;
    const ticker = String(req.body?.ticker ?? '').trim().toUpperCase();
    const signal = String(req.body?.signal ?? '').trim().toUpperCase();
    const mode = String(req.body?.mode ?? 'SWING_TRADE').trim().toUpperCase();
    const confidence = Number(req.body?.confidence ?? 7);
    const executeOnDate = String(req.body?.executeOnDate ?? '').trim();
    const entryPrice = parseOptionalNumber(req.body?.entryPrice);
    const stopLoss = parseOptionalNumber(req.body?.stopLoss);
    const targetPrice = parseOptionalNumber(req.body?.targetPrice);
    const positionSizeOverride = parseOptionalNumber(req.body?.positionSizeOverride);
    const executeAt = req.body?.executeAt ? String(req.body.executeAt) : null;
    const expiresAt = req.body?.expiresAt ? String(req.body.expiresAt) : null;
    const notes = req.body?.notes ? String(req.body.notes) : null;

    if (!sourceName) return res.status(400).json({ error: 'sourceName is required' });
    if (!ticker) return res.status(400).json({ error: 'ticker is required' });
    if (!VALID_SIGNALS.has(signal)) return res.status(400).json({ error: 'signal must be BUY or SELL' });
    if (!VALID_MODES.has(mode)) return res.status(400).json({ error: 'mode must be DAY_TRADE, SWING_TRADE, or LONG_TERM' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(executeOnDate)) return res.status(400).json({ error: 'executeOnDate must be YYYY-MM-DD' });
    if (!Number.isFinite(confidence) || confidence < 1 || confidence > 10) {
      return res.status(400).json({ error: 'confidence must be between 1 and 10' });
    }
    if (req.body?.entryPrice != null && entryPrice == null) return res.status(400).json({ error: 'entryPrice must be numeric' });
    if (req.body?.stopLoss != null && stopLoss == null) return res.status(400).json({ error: 'stopLoss must be numeric' });
    if (req.body?.targetPrice != null && targetPrice == null) return res.status(400).json({ error: 'targetPrice must be numeric' });
    if (req.body?.positionSizeOverride != null && positionSizeOverride == null) {
      return res.status(400).json({ error: 'positionSizeOverride must be numeric' });
    }
    if (executeAt && Number.isNaN(new Date(executeAt).getTime())) {
      return res.status(400).json({ error: 'executeAt must be a valid ISO datetime' });
    }
    if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) {
      return res.status(400).json({ error: 'expiresAt must be a valid ISO datetime' });
    }

    const created = await createExternalStrategySignal({
      source_name: sourceName,
      source_url: sourceUrl,
      strategy_video_id: strategyVideoId,
      strategy_video_heading: strategyVideoHeading,
      ticker,
      signal,
      mode,
      confidence: Math.round(confidence),
      execute_on_date: executeOnDate,
      entry_price: entryPrice,
      stop_loss: stopLoss,
      target_price: targetPrice,
      position_size_override: positionSizeOverride,
      execute_at: executeAt,
      expires_at: expiresAt,
      notes,
    });

    res.status(201).json({ signal: created });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create strategy signal' });
  }
});

router.patch('/strategy-signals/:id', async (req, res) => {
  try {
    const id = String(req.params.id ?? '').trim();
    const statusRaw = req.body?.status ? String(req.body.status).trim().toUpperCase() : undefined;
    const failureReason = req.body?.failureReason != null ? String(req.body.failureReason) : null;
    if (!id) return res.status(400).json({ error: 'id is required' });
    if (statusRaw && !VALID_STATUSES.has(statusRaw)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const updates: Record<string, unknown> = {};
    if (statusRaw) updates.status = statusRaw;
    if (failureReason !== null) updates.failure_reason = failureReason;
    if (statusRaw === 'CANCELLED' || statusRaw === 'SKIPPED') {
      updates.executed_at = null;
      updates.executed_trade_id = null;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    await updateExternalStrategySignal(id, updates);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update strategy signal' });
  }
});

router.get('/strategy-performance', async (_req, res) => {
  try {
    const sources = await getStrategySourcePerformance();
    res.json({ sources });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load strategy performance' });
  }
});

export default router;
