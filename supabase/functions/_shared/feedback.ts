/**
 * AI Feedback Context — shared across edge functions.
 *
 * Reads trade_performance + trade_learnings from Supabase and builds
 * a prompt section that tells the AI about past wins/losses so it can
 * calibrate confidence and avoid repeating mistakes.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

function getSupabase() {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export async function buildFeedbackContext(): Promise<string> {
  try {
    const sb = getSupabase();

    const [perfRes, learningsRes] = await Promise.all([
      sb.from('trade_performance').select('*').eq('id', 'global').single(),
      sb.from('trade_learnings')
        .select('outcome, lesson, what_worked, what_failed')
        .order('created_at', { ascending: false })
        .limit(10),
    ]);

    const perf = perfRes.data;
    const learnings = learningsRes.data ?? [];

    if (!perf || perf.total_trades === 0) return '';

    const lines: string[] = [
      '',
      '--- HISTORICAL PERFORMANCE (paper trading) ---',
      `Total: ${perf.total_trades} trades | Win rate: ${Number(perf.win_rate).toFixed(1)}% | Total P&L: $${Number(perf.total_pnl).toFixed(2)}`,
      `Avg win: $${Number(perf.avg_win).toFixed(2)} | Avg loss: $${Number(perf.avg_loss).toFixed(2)}`,
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
  } catch (err) {
    console.warn('[Feedback] Failed to build feedback context:', err);
    return '';
  }
}
