#!/usr/bin/env node
/**
 * Swing trade underperformance diagnostics.
 * Run: cd auto-trader && npx tsx scripts/swing-diagnostics.ts
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env
 */

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in auto-trader/.env');
  process.exit(1);
}

const supabase = createClient(url, key);

async function main() {
  const { data: trades, error } = await supabase
    .from('paper_trades')
    .select('*')
    .eq('mode', 'SWING_TRADE');

  if (error) {
    console.error('Failed to fetch:', error.message);
    process.exit(1);
  }

  const closed = (trades ?? []).filter(
    (t: { fill_price: unknown; status: string }) =>
      t.fill_price != null && ['STOPPED', 'TARGET_HIT', 'CLOSED'].includes(t.status)
  );
  const bracketOrders = (trades ?? []).filter(
    (t: { entry_trigger_type?: string }) => t.entry_trigger_type === 'bracket_limit'
  );
  const filled = bracketOrders.filter((t: { fill_price: unknown }) => t.fill_price != null);
  const neverFilled = bracketOrders.filter(
    (t: { status: string; fill_price: unknown }) =>
      ['SUBMITTED', 'CLOSED'].includes(t.status) && t.fill_price == null
  );

  console.log('\n📊 SWING TRADE UNDERPERFORMANCE DIAGNOSTICS\n');
  console.log('─'.repeat(60));

  // A) Chop vs Trend
  const byRegime = new Map<string, { trades: number; wins: number; pnl: number }>();
  for (const t of closed) {
    const mc = (t as { market_condition?: string }).market_condition ?? 'unknown';
    const cur = byRegime.get(mc) ?? { trades: 0, wins: 0, pnl: 0 };
    cur.trades++;
    if ((t as { pnl?: number }).pnl! > 0) cur.wins++;
    cur.pnl += (t as { pnl?: number }).pnl ?? 0;
    byRegime.set(mc, cur);
  }
  console.log('\nA) CHOP vs TREND (market_condition)');
  for (const [mc, s] of byRegime) {
    const wr = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(1) : '—';
    console.log(`   ${mc}: ${s.trades} trades, ${wr}% win rate, PnL $${s.pnl.toFixed(2)}`);
  }
  if (byRegime.size === 0) console.log('   No closed swing trades with market_condition yet.');

  // C) & D) Close reason + days held
  const byReason = new Map<string, { trades: number; pnl: number; daysHeld: number[] }>();
  for (const t of closed) {
    const reason = (t as { close_reason?: string }).close_reason ?? 'unknown';
    const cur = byReason.get(reason) ?? { trades: 0, pnl: 0, daysHeld: [] };
    cur.trades++;
    cur.pnl += (t as { pnl?: number }).pnl ?? 0;
    const filledAt = (t as { filled_at?: string }).filled_at;
    const closedAt = (t as { closed_at?: string }).closed_at;
    if (filledAt && closedAt) {
      cur.daysHeld.push((new Date(closedAt).getTime() - new Date(filledAt).getTime()) / 86400000);
    }
    byReason.set(reason, cur);
  }
  console.log('\nC) & D) CLOSE REASON + AVG DAYS HELD');
  for (const [reason, s] of byReason) {
    const avgDays = s.daysHeld.length > 0
      ? (s.daysHeld.reduce((a, b) => a + b, 0) / s.daysHeld.length).toFixed(1)
      : '—';
    console.log(`   ${reason}: ${s.trades} trades, PnL $${s.pnl.toFixed(2)}, avg ${avgDays} days`);
  }

  // C) Quick failures
  const quickStops = closed.filter((t: { close_reason?: string; filled_at?: string; closed_at?: string }) => {
    if (t.close_reason !== 'stop_loss' || !t.filled_at || !t.closed_at) return false;
    const days = (new Date(t.closed_at).getTime() - new Date(t.filled_at).getTime()) / 86400000;
    return days < 2;
  });
  const quickStopPnl = quickStops.reduce((s: number, t: { pnl?: number }) => s + (t.pnl ?? 0), 0);
  const totalLosses = closed.filter((t: { pnl?: number }) => (t.pnl ?? 0) < 0);
  const totalLossPnl = totalLosses.reduce((s: number, t: { pnl?: number }) => s + (t.pnl ?? 0), 0);
  console.log('\nC) QUICK FAILURES (stop_loss < 2 days)');
  console.log(`   Quick stops: ${quickStops.length}, PnL $${quickStopPnl.toFixed(2)}`);
  if (totalLosses.length > 0) {
    const pct = ((quickStopPnl / totalLossPnl) * 100).toFixed(0);
    console.log(`   Share of total losses: ${pct}%`);
  }

  // E) Fill rate
  console.log('\nE) FILL RATE (bracket_limit orders)');
  const fillRate = bracketOrders.length > 0
    ? ((filled.length / bracketOrders.length) * 100).toFixed(1)
    : '—';
  console.log(`   Total bracket orders: ${bracketOrders.length}`);
  console.log(`   Filled: ${filled.length}`);
  console.log(`   Never filled: ${neverFilled.length}`);
  console.log(`   Fill rate: ${fillRate}%`);

  // Verdict
  console.log('\n' + '─'.repeat(60));
  console.log('VERDICT (next upgrade):');
  const chop = byRegime.get('chop');
  const trend = byRegime.get('trend');
  if (chop && trend && chop.trades >= 3 && chop.pnl < trend.pnl - 50) {
    console.log('   → A) Regime refinement (chop underperforming)');
  } else if (quickStops.length >= totalLosses.length * 0.5 && totalLosses.length >= 2) {
    console.log('   → C) Pullback quality refinement (quick failures)');
  } else if (filled.length < bracketOrders.length * 0.5 && bracketOrders.length >= 5) {
    console.log('   → E) Execution refinement (low fill rate)');
  } else if (closed.length < 5) {
    console.log('   → Need more data (fewer than 5 closed swing trades)');
  } else {
    console.log('   → Run full analysis; no single dominant pattern yet.');
  }
  console.log('');
}

main().catch(console.error);
