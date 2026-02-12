/**
 * AI Feedback Loop — analyzes completed trade outcomes and generates
 * learnings that are fed back into future AI prompts.
 *
 * Flow:
 *   1. Trade completes (stopped/target hit/closed)
 *   2. AI analyzes: what worked, what failed, market context
 *   3. Learning stored in trade_learnings table
 *   4. Performance stats updated in trade_performance table
 *   5. Recent learnings included in scanner/FA prompts as context
 */

import { supabase } from './supabaseClient';
import type { PaperTrade } from './paperTradesApi';
import {
  createTradeLearning,
  getRecentLearnings,
  recalculatePerformance,
  type TradeLearning,
  type TradePerformance,
} from './paperTradesApi';

// ── Trade Analysis ───────────────────────────────────────

/**
 * Analyze a completed trade and generate a learning.
 * Uses the same Gemini model as trading signals for consistency.
 */
export async function analyzeCompletedTrade(trade: PaperTrade): Promise<TradeLearning | null> {
  if (!trade.closed_at || !trade.pnl) return null;

  const outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' =
    trade.pnl > 0 ? 'WIN' : trade.pnl < 0 ? 'LOSS' : 'BREAKEVEN';

  // Build analysis context
  const context = {
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
    duration: trade.closed_at && trade.opened_at
      ? Math.round((new Date(trade.closed_at).getTime() - new Date(trade.opened_at).getTime()) / 60000)
      : null,
  };

  // Generate lesson (simple heuristic analysis — no extra API call needed)
  const lesson = generateLesson(context, outcome);

  const learning = await createTradeLearning({
    trade_id: trade.id,
    outcome,
    lesson: lesson.lesson,
    what_worked: lesson.whatWorked,
    what_failed: lesson.whatFailed,
    market_context: lesson.marketContext,
  });

  // Recalculate aggregate performance
  await recalculatePerformance();

  return learning;
}

// ── Heuristic Lesson Generator ───────────────────────────

interface TradeContext {
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
}

interface LessonResult {
  lesson: string;
  whatWorked: string;
  whatFailed: string;
  marketContext: string;
}

function generateLesson(ctx: TradeContext, outcome: 'WIN' | 'LOSS' | 'BREAKEVEN'): LessonResult {
  const parts: string[] = [];
  const worked: string[] = [];
  const failed: string[] = [];

  // Confidence analysis
  const avgConf = ((ctx.scannerConfidence ?? 0) + (ctx.faConfidence ?? 0)) / 2;

  if (outcome === 'WIN') {
    parts.push(`${ctx.ticker} ${ctx.signal} was correct.`);

    if (avgConf >= 8) worked.push('High confidence (8+) signals are reliable');
    if (avgConf >= 7 && avgConf < 8) worked.push('7+ confidence met threshold and delivered');
    if (ctx.closeReason === 'target_hit') worked.push('Target price was well-calibrated');

    // Duration analysis
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

    if (ctx.closeReason === 'eod_close') {
      failed.push('Day trade did not reach target before close');
    }

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

  // P&L context
  if (ctx.pnlPercent) {
    parts.push(`P&L: ${ctx.pnlPercent >= 0 ? '+' : ''}${ctx.pnlPercent.toFixed(1)}%`);
  }

  return {
    lesson: parts.join(' '),
    whatWorked: worked.join('; ') || 'N/A',
    whatFailed: failed.join('; ') || 'N/A',
    marketContext: ctx.scannerReason ?? 'No market context recorded',
  };
}

// ── Feedback Context for Prompts ─────────────────────────

/**
 * Build a feedback context string from recent trade learnings.
 * This is injected into scanner/FA prompts so the AI can learn from history.
 */
export async function buildFeedbackContext(): Promise<string> {
  const [learnings, perfData] = await Promise.all([
    getRecentLearnings(10),
    supabase.from('trade_performance').select('*').eq('id', 'global').single(),
  ]);

  const perf = perfData.data as TradePerformance | null;

  if (!perf || perf.total_trades === 0) {
    return ''; // No history yet
  }

  const lines: string[] = [
    '--- HISTORICAL PERFORMANCE (paper trading) ---',
    `Total: ${perf.total_trades} trades | Win rate: ${perf.win_rate.toFixed(1)}% | Total P&L: $${perf.total_pnl.toFixed(2)}`,
    `Avg win: $${perf.avg_win.toFixed(2)} | Avg loss: $${perf.avg_loss.toFixed(2)}`,
  ];

  if (perf.common_win_patterns?.length) {
    lines.push(`Winning patterns: ${perf.common_win_patterns.join(', ')}`);
  }
  if (perf.common_loss_patterns?.length) {
    lines.push(`Losing patterns: ${perf.common_loss_patterns.join(', ')}`);
  }

  if (learnings.length > 0) {
    lines.push('');
    lines.push('Recent lessons:');
    for (const l of learnings.slice(0, 5)) {
      lines.push(`- [${l.outcome}] ${l.lesson ?? ''}`);
      if (l.what_failed && l.what_failed !== 'N/A') {
        lines.push(`  What failed: ${l.what_failed}`);
      }
    }
  }

  lines.push('');
  lines.push('Use this history to calibrate confidence. If similar setups have been losing, reduce confidence or SKIP.');
  lines.push('---');

  return lines.join('\n');
}

// ── Auto-Analyze All Unchecked Trades ────────────────────

/**
 * Find completed trades that haven't been analyzed yet and analyze them.
 * Call this periodically (e.g., when Paper Trading page loads).
 */
export async function analyzeUnreviewedTrades(): Promise<number> {
  // Get closed trades without learnings
  const { data: closedTrades, error: tErr } = await supabase
    .from('paper_trades')
    .select('*')
    .in('status', ['STOPPED', 'TARGET_HIT', 'CLOSED'])
    .order('closed_at', { ascending: false })
    .limit(20);

  if (tErr || !closedTrades) return 0;

  const { data: existingLearnings, error: lErr } = await supabase
    .from('trade_learnings')
    .select('trade_id');

  if (lErr) return 0;

  const analyzedIds = new Set((existingLearnings ?? []).map(l => l.trade_id));
  const unreviewed = (closedTrades as PaperTrade[]).filter(t => !analyzedIds.has(t.id));

  let count = 0;
  for (const trade of unreviewed) {
    const learning = await analyzeCompletedTrade(trade);
    if (learning) count++;
  }

  return count;
}

// ── Update Performance Patterns ──────────────────────────

/**
 * Analyze all learnings to find common win/loss patterns.
 * Updates the trade_performance table.
 */
export async function updatePerformancePatterns(): Promise<void> {
  const { data: learnings } = await supabase
    .from('trade_learnings')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);

  if (!learnings || learnings.length < 5) return;

  const wins = (learnings as TradeLearning[]).filter(l => l.outcome === 'WIN');
  const losses = (learnings as TradeLearning[]).filter(l => l.outcome === 'LOSS');

  // Extract common patterns from "what_worked" and "what_failed"
  const winPatterns = extractPatterns(wins.map(w => w.what_worked ?? ''));
  const lossPatterns = extractPatterns(losses.map(l => l.what_failed ?? ''));

  // Build AI summary
  const winRate = wins.length / learnings.length * 100;
  const summary = [
    `Paper trading performance: ${winRate.toFixed(0)}% win rate over ${learnings.length} analyzed trades.`,
    winPatterns.length > 0 ? `Winning setups tend to have: ${winPatterns.join(', ')}.` : '',
    lossPatterns.length > 0 ? `Losing setups tend to have: ${lossPatterns.join(', ')}.` : '',
  ].filter(Boolean).join(' ');

  await supabase
    .from('trade_performance')
    .update({
      common_win_patterns: winPatterns,
      common_loss_patterns: lossPatterns,
      ai_summary: summary,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 'global');
}

/** Simple pattern extraction from learning text */
function extractPatterns(texts: string[]): string[] {
  const keywords: Record<string, number> = {};

  for (const text of texts) {
    const lower = text.toLowerCase();
    const patterns = [
      'high confidence', 'low confidence', 'momentum', 'volume',
      'stop too tight', 'stop too wide', 'target well-calibrated',
      'quick execution', 'market regime', 'scanner-fa gap',
      'risk management', 'entry aggressive', 'trend following',
    ];

    for (const p of patterns) {
      if (lower.includes(p)) {
        keywords[p] = (keywords[p] ?? 0) + 1;
      }
    }
  }

  return Object.entries(keywords)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([pattern]) => pattern);
}
