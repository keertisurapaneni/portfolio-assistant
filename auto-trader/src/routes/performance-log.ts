/**
 * POST /api/performance-log/close (legacy, trigger=IB_POSITION_GONE)
 * POST /api/trade-performance-log/close
 * Unified logging for all closed trades (DAY_TRADE, SWING_TRADE, LONG_TERM).
 */

import { Router } from 'express';
import { getSupabase } from '../lib/supabase.js';
import { logClosedTradePerformance } from '../lib/tradePerformanceLog.js';
import { logLongTermPerformance } from '../lib/performanceLog.js';
import type { PaperTrade } from '../lib/supabase.js';

const router = Router();
const TRIGGERS = ['EOD_CLOSE', 'IB_POSITION_GONE', 'EXPIRED_DAY_ORDER', 'EXPIRED_SWING_BRACKET'] as const;

async function logClose(tradeId: string, trigger: (typeof TRIGGERS)[number]) {
  const sb = getSupabase();
  const { data, error } = await sb.from('paper_trades').select('*').eq('id', tradeId).single();
  if (error || !data) throw new Error('Trade not found');
  const trade = data as PaperTrade;
  if (!trade.closed_at) throw new Error('Trade not closed');
  if (trade.mode === 'LONG_TERM' && !(trade.notes ?? '').startsWith('Dip buy') && trade.filled_at) {
    await logLongTermPerformance(trade);
  }
  await logClosedTradePerformance(trade, { source: 'app', trigger });
}

router.post('/performance-log/close', async (req, res) => {
  const tradeId = req.body?.tradeId ?? req.body?.trade_id;
  if (!tradeId || typeof tradeId !== 'string') return res.status(400).json({ error: 'Missing tradeId' });
  try {
    await logClose(tradeId, 'IB_POSITION_GONE');
    res.json({ ok: true });
  } catch (err) {
    console.error('[performance-log/close]:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

router.post('/trade-performance-log/close', async (req, res) => {
  const tradeId = req.body?.tradeId ?? req.body?.trade_id;
  const trigger = TRIGGERS.includes(req.body?.trigger as any) ? req.body.trigger : 'IB_POSITION_GONE';
  if (!tradeId || typeof tradeId !== 'string') return res.status(400).json({ error: 'Missing tradeId' });
  try {
    await logClose(tradeId, trigger);
    res.json({ ok: true });
  } catch (err) {
    console.error('[trade-performance-log/close]:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

router.get('/trade-performance-log/summary', async (req, res) => {
  try {
    const { getPerformanceSummary } = await import('../lib/tradePerformanceMetrics.js');
    const asOf = req.query.asOf ? new Date(req.query.asOf as string) : undefined;
    const summary = await getPerformanceSummary({ asOf });
    res.json(summary);
  } catch (err) {
    console.error('[trade-performance-log/summary]:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

router.get('/trade-performance-log/weekly-report', async (req, res) => {
  try {
    const { generateWeeklyReport } = await import('../lib/weeklyReport.js');
    const asOf = req.query.asOf ? new Date(req.query.asOf as string) : undefined;
    const report = await generateWeeklyReport({ asOf });
    res.json(report);
  } catch (err) {
    console.error('[trade-performance-log/weekly-report]:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

export default router;
