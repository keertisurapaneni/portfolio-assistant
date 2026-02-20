#!/usr/bin/env node
/**
 * Backfill trade_performance_log from existing closed paper_trades.
 * Run once after migration. Idempotent — skips trades already logged.
 *
 * Usage: cd auto-trader && npx tsx src/scripts/backfillTradePerformanceLog.ts
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env
 */

import 'dotenv/config';
import { getSupabase } from '../lib/supabase.js';
import { logClosedTradePerformance } from '../lib/tradePerformanceLog.js';
import type { PaperTrade } from '../lib/supabase.js';

const CLOSED_STATUSES = ['CLOSED', 'STOPPED', 'TARGET_HIT'];

async function main() {
  const sb = getSupabase();

  // Fetch all closed trades (with closed_at, not dip buys)
  const { data: closedTrades, error: fetchError } = await sb
    .from('paper_trades')
    .select('*')
    .in('status', CLOSED_STATUSES)
    .not('closed_at', 'is', null)
    .order('closed_at', { ascending: true });

  if (fetchError) {
    console.error('Failed to fetch paper_trades:', fetchError.message);
    process.exit(1);
  }

  const trades = (closedTrades ?? []) as PaperTrade[];
  const filtered = trades.filter(t => !(t.notes ?? '').startsWith('Dip buy'));

  if (filtered.length === 0) {
    console.log('No closed trades to backfill.');
    return;
  }

  // Get already-logged trade IDs
  const { data: existing } = await sb
    .from('trade_performance_log')
    .select('trade_id');
  const loggedIds = new Set((existing ?? []).map((r: { trade_id: string }) => r.trade_id));

  const toBackfill = filtered.filter(t => !loggedIds.has(t.id));
  console.log(`Found ${filtered.length} closed trades, ${loggedIds.size} already logged, ${toBackfill.length} to backfill.`);

  let ok = 0;
  let err = 0;
  for (const trade of toBackfill) {
    try {
      await logClosedTradePerformance(trade, { source: 'scheduler', trigger: 'IB_POSITION_GONE' });
      ok++;
      console.log(`  ✓ ${trade.ticker} (${trade.mode}) closed ${trade.closed_at?.slice(0, 10)}`);
    } catch (e) {
      err++;
      console.error(`  ✗ ${trade.ticker}:`, e instanceof Error ? e.message : e);
    }
    await new Promise(r => setTimeout(r, 300)); // rate limit Yahoo/Finnhub
  }

  console.log(`\nDone. Backfilled ${ok}, errors ${err}.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
