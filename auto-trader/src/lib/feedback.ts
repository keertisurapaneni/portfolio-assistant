/**
 * Trade feedback loop — analyze completed trades, update performance patterns.
 * Ported from app/src/lib/aiFeedback.ts for server-side rehydration.
 * Feeds buildFeedbackContext in edge functions so AI learns from history.
 */

import { getSupabase } from './supabase.js';

interface PaperTradeLike {
  id: string;
  ticker: string;
  mode: string;
  signal: string;
  scanner_confidence: number | null;
  fa_confidence: number | null;
  fa_recommendation: string | null;
  entry_price: number | null;
  stop_loss: number | null;
  target_price: number | null;
  fill_price: number | null;
  close_price: number | null;
  pnl: number | null;
  pnl_percent: number | null;
  close_reason: string | null;
  fa_rationale: { technical?: string; sentiment?: string; risk?: string } | null;
  scanner_reason: string | null;
  opened_at: string | null;
  closed_at: string | null;
}

interface LessonResult {
  lesson: string;
  whatWorked: string;
  whatFailed: string;
  marketContext: string;
}

function generateLesson(
  ctx: {
    ticker: string;
    mode: string;
    signal: string;
    scannerConfidence: number | null;
    faConfidence: number | null;
    faRecommendation: string | null;
    entryPrice: number | null;
    stopLoss: number | null;
    targetPrice: number | null;
    fillPrice: number | null;
    closePrice: number | null;
    pnl: number | null;
    pnlPercent: number | null;
    closeReason: string | null;
    faRationale: { technical?: string; sentiment?: string; risk?: string } | null;
    scannerReason: string | null;
    duration: number | null;
  },
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN'
): LessonResult {
  const parts: string[] = [];
  const worked: string[] = [];
  const failed: string[] = [];

  const avgConf = ((ctx.scannerConfidence ?? 0) + (ctx.faConfidence ?? 0)) / 2;

  if (outcome === 'WIN') {
    parts.push(`${ctx.ticker} ${ctx.signal} was correct.`);
    if (avgConf >= 8) worked.push('High confidence (8+) signals are reliable');
    if (avgConf >= 7 && avgConf < 8) worked.push('7+ confidence met threshold and delivered');
    if (ctx.closeReason === 'target_hit') worked.push('Target price was well-calibrated');
    if (ctx.duration && ctx.mode === 'DAY_TRADE') {
      if (ctx.duration < 60) worked.push('Quick execution — momentum was strong');
      else if (ctx.duration > 240) parts.push('Took longer than expected for a day trade');
    }
    if (ctx.faRationale?.technical) worked.push(`Technical: ${ctx.faRationale.technical.slice(0, 100)}`);
  } else if (outcome === 'LOSS') {
    parts.push(`${ctx.ticker} ${ctx.signal} was incorrect.`);
    if (ctx.closeReason === 'stop_loss') {
      failed.push('Stop loss was hit — entry may have been too aggressive');
      if (ctx.entryPrice && ctx.stopLoss) {
        const stopDist = Math.abs(ctx.entryPrice - ctx.stopLoss) / ctx.entryPrice * 100;
        if (stopDist < 1.5) failed.push(`Stop was too tight (${stopDist.toFixed(1)}%)`);
        if (stopDist > 5) failed.push(`Stop was wide but still hit (${stopDist.toFixed(1)}%)`);
      }
    }
    if (ctx.closeReason === 'eod_close') failed.push('Day trade did not reach target before close');
    if (avgConf >= 8) failed.push('High confidence but still lost — may indicate market regime change');
    if (ctx.scannerConfidence !== null && ctx.faConfidence !== null) {
      const confDiff = Math.abs(ctx.scannerConfidence - ctx.faConfidence);
      if (confDiff >= 3) failed.push(`Large scanner-FA confidence gap (${confDiff}pts) — signals were uncertain`);
    }
    if (ctx.faRationale?.risk) failed.push(`Risk factor: ${ctx.faRationale.risk.slice(0, 100)}`);
  } else {
    parts.push(`${ctx.ticker} was a breakeven trade.`);
    worked.push('Risk management worked — minimal loss');
  }

  if (ctx.pnlPercent != null) {
    parts.push(`P&L: ${ctx.pnlPercent >= 0 ? '+' : ''}${ctx.pnlPercent.toFixed(1)}%`);
  }

  return {
    lesson: parts.join(' '),
    whatWorked: worked.join('; ') || 'N/A',
    whatFailed: failed.join('; ') || 'N/A',
    marketContext: ctx.scannerReason ?? 'No market context recorded',
  };
}

function extractPatterns(texts: string[]): string[] {
  const keywords: Record<string, number> = {};
  const patterns = [
    'high confidence', 'low confidence', 'momentum', 'volume',
    'stop too tight', 'stop too wide', 'target well-calibrated',
    'quick execution', 'market regime', 'scanner-fa gap',
    'risk management', 'entry aggressive', 'trend following',
  ];

  for (const text of texts) {
    const lower = text.toLowerCase();
    for (const p of patterns) {
      if (lower.includes(p)) keywords[p] = (keywords[p] ?? 0) + 1;
    }
  }

  return Object.entries(keywords)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([pattern]) => pattern);
}

export async function recalculatePerformance(): Promise<boolean> {
  const sb = getSupabase();
  const { data: trades, error } = await sb
    .from('paper_trades')
    .select('*')
    .in('status', ['STOPPED', 'TARGET_HIT', 'CLOSED']);

  if (error || !trades || trades.length === 0) return false;

  const completed = trades.filter((t: { fill_price: unknown }) => t.fill_price != null);
  const wins = completed.filter((t: { pnl: number }) => (t.pnl ?? 0) > 0);
  const losses = completed.filter((t: { pnl: number }) => (t.pnl ?? 0) < 0);
  const breakevens = completed.filter((t: { pnl: number }) => (t.pnl ?? 0) === 0);

  const totalPnl = completed.reduce((sum: number, t: { pnl: number }) => sum + (t.pnl ?? 0), 0);
  const avgPnl = completed.length > 0 ? totalPnl / completed.length : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s: number, t: { pnl: number }) => s + (t.pnl ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s: number, t: { pnl: number }) => s + (t.pnl ?? 0), 0) / losses.length : 0;
  const bestPnl = Math.max(...completed.map((t: { pnl: number }) => t.pnl ?? 0), 0);
  const worstPnl = Math.min(...completed.map((t: { pnl: number }) => t.pnl ?? 0), 0);

  const { error: updateErr } = await sb
    .from('trade_performance')
    .update({
      total_trades: completed.length,
      wins: wins.length,
      losses: losses.length,
      breakevens: breakevens.length,
      win_rate: completed.length > 0 ? (wins.length / completed.length) * 100 : 0,
      avg_pnl: avgPnl,
      avg_win: avgWin,
      avg_loss: avgLoss,
      total_pnl: totalPnl,
      best_trade_pnl: bestPnl,
      worst_trade_pnl: worstPnl,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 'global');

  return !updateErr;
}

export async function analyzeCompletedTrade(trade: PaperTradeLike): Promise<boolean> {
  if (!trade.closed_at || trade.pnl == null) return false;

  const outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' =
    trade.pnl > 0 ? 'WIN' : trade.pnl < 0 ? 'LOSS' : 'BREAKEVEN';

  const duration = trade.opened_at && trade.closed_at
    ? Math.round((new Date(trade.closed_at).getTime() - new Date(trade.opened_at).getTime()) / 60000)
    : null;

  const lesson = generateLesson(
    {
      ticker: trade.ticker,
      mode: trade.mode,
      signal: trade.signal,
      scannerConfidence: trade.scanner_confidence,
      faConfidence: trade.fa_confidence,
      faRecommendation: trade.fa_recommendation,
      entryPrice: trade.entry_price,
      stopLoss: trade.stop_loss,
      targetPrice: trade.target_price,
      fillPrice: trade.fill_price,
      closePrice: trade.close_price,
      pnl: trade.pnl,
      pnlPercent: trade.pnl_percent,
      closeReason: trade.close_reason,
      faRationale: trade.fa_rationale,
      scannerReason: trade.scanner_reason,
      duration,
    },
    outcome
  );

  const sb = getSupabase();
  const { error } = await sb.from('trade_learnings').insert({
    trade_id: trade.id,
    outcome,
    lesson: lesson.lesson,
    what_worked: lesson.whatWorked,
    what_failed: lesson.whatFailed,
    market_context: lesson.marketContext,
  });

  return !error;
}

export async function analyzeUnreviewedTrades(): Promise<number> {
  const sb = getSupabase();

  const { data: closedTrades, error: tErr } = await sb
    .from('paper_trades')
    .select('*')
    .in('status', ['STOPPED', 'TARGET_HIT', 'CLOSED'])
    .order('closed_at', { ascending: false })
    .limit(20);

  if (tErr || !closedTrades || closedTrades.length === 0) return 0;

  const { data: existingLearnings, error: lErr } = await sb
    .from('trade_learnings')
    .select('trade_id');

  if (lErr) return 0;

  const analyzedIds = new Set((existingLearnings ?? []).map((l: { trade_id: string }) => l.trade_id));
  const unreviewed = closedTrades.filter((t: { id: string }) => !analyzedIds.has(t.id));

  let count = 0;
  for (const trade of unreviewed) {
    const ok = await analyzeCompletedTrade(trade as PaperTradeLike);
    if (ok) count++;
  }

  return count;
}

export async function updatePerformancePatterns(): Promise<void> {
  const sb = getSupabase();

  const { data: learnings } = await sb
    .from('trade_learnings')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);

  if (!learnings || learnings.length < 5) return;

  const wins = learnings.filter((l: { outcome: string }) => l.outcome === 'WIN');
  const losses = learnings.filter((l: { outcome: string }) => l.outcome === 'LOSS');

  const winPatterns = extractPatterns(wins.map((w: { what_worked: string }) => w.what_worked ?? ''));
  const lossPatterns = extractPatterns(losses.map((l: { what_failed: string }) => l.what_failed ?? ''));

  const winRate = wins.length / learnings.length * 100;
  const summary = [
    `Paper trading performance: ${winRate.toFixed(0)}% win rate over ${learnings.length} analyzed trades.`,
    winPatterns.length > 0 ? `Winning setups tend to have: ${winPatterns.join(', ')}.` : '',
    lossPatterns.length > 0 ? `Losing setups tend to have: ${lossPatterns.join(', ')}.` : '',
  ].filter(Boolean).join(' ');

  await sb
    .from('trade_performance')
    .update({
      common_win_patterns: winPatterns,
      common_loss_patterns: lossPatterns,
      ai_summary: summary,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 'global');
}
