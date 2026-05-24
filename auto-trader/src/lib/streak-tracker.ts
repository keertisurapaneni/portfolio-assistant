/**
 * Strategy-level cold streak detector.
 *
 * Inspired by James Rich Young: track each strategy's recent performance
 * independently. When a strategy goes cold (rolling win rate drops below
 * threshold), halve position size. Don't restore until win rate convincingly
 * recovers (hysteresis band prevents flip-flopping).
 *
 * This is a position sizing MULTIPLIER, not a gate. The strategy keeps
 * trading at reduced size so we can detect recovery.
 *
 * Composes multiplicatively with Kelly and market regime:
 *   base × Kelly × regime × streak = final size
 */

import { getSupabase, tradesTable, streakTable } from './supabase.js';
import { CLOSED_STATUSES } from '../../../shared/trade-status-sets.js';
import type { AccountType } from '../../../shared/trade-types.js';

const log = (msg: string) => console.log(`[StreakTracker] ${msg}`);

interface StreakConfig {
  windowSize: number;
  coldThreshold: number;
  recoveryThreshold: number;
}

const STREAK_CONFIGS: Record<string, StreakConfig> = {
  DAY_TRADE:  { windowSize: 10, coldThreshold: 0.35, recoveryThreshold: 0.50 },
  DAY_PENNY:  { windowSize: 10, coldThreshold: 0.25, recoveryThreshold: 0.40 },
  SWING_TRADE: { windowSize: 10, coldThreshold: 0.30, recoveryThreshold: 0.50 },
};

const COLD_MULTIPLIER = 0.5;

interface StreakState {
  mode: string;
  is_cold: boolean;
  entered_cold_at: string | null;
  rolling_win_rate: number | null;
}

/**
 * Returns a position sizing multiplier for the given trade mode.
 * 1.0 = normal, 0.5 = cold streak active.
 *
 * Non-blocking: returns 1.0 on any error (never silently kills sizing).
 */
export async function getStreakMultiplier(mode: string, accountType: AccountType = 'paper'): Promise<number> {
  const config = STREAK_CONFIGS[mode];
  if (!config) return 1.0;

  try {
    const sb = getSupabase();
    const tTable = tradesTable(accountType);
    const sTable = streakTable(accountType);

    const { data: trades, error: tradeErr } = await sb
      .from(tTable)
      .select('pnl')
      .eq('mode', mode)
      .in('status', [...CLOSED_STATUSES])
      .not('pnl', 'is', null)
      .not('fill_price', 'is', null)
      .order('closed_at', { ascending: false })
      .limit(config.windowSize);

    if (tradeErr || !trades || trades.length < config.windowSize) {
      return 1.0;
    }

    const wins = trades.filter(t => t.pnl > 0).length;
    const winRate = wins / trades.length;

    const { data: stateRow } = await sb
      .from(sTable)
      .select('is_cold, entered_cold_at, rolling_win_rate')
      .eq('mode', mode)
      .single();

    const wasCold = stateRow?.is_cold ?? false;
    let isCold: boolean;

    if (wasCold) {
      isCold = winRate < config.recoveryThreshold;
    } else {
      isCold = winRate < config.coldThreshold;
    }

    const stateChanged = isCold !== wasCold;
    if (stateChanged || !stateRow) {
      await sb
        .from(sTable)
        .upsert({
          mode,
          is_cold: isCold,
          entered_cold_at: isCold && !wasCold ? new Date().toISOString() : (stateRow?.entered_cold_at ?? null),
          last_checked_at: new Date().toISOString(),
          rolling_win_rate: winRate,
          window_size: config.windowSize,
        });

      if (isCold && !wasCold) {
        log(`⚠️ ${mode} entered cold streak — win rate ${(winRate * 100).toFixed(0)}% (last ${config.windowSize} trades) < ${(config.coldThreshold * 100).toFixed(0)}% threshold → position size ×${COLD_MULTIPLIER}`);
      } else if (!isCold && wasCold) {
        log(`✅ ${mode} recovered from cold streak — win rate ${(winRate * 100).toFixed(0)}% > ${(config.recoveryThreshold * 100).toFixed(0)}% recovery threshold → full size restored`);
      }
    } else {
      await sb
        .from(sTable)
        .update({
          last_checked_at: new Date().toISOString(),
          rolling_win_rate: winRate,
        })
        .eq('mode', mode);
    }

    return isCold ? COLD_MULTIPLIER : 1.0;
  } catch (err) {
    log(`Error checking streak for ${mode}: ${err instanceof Error ? err.message : 'unknown'} — returning 1.0`);
    return 1.0;
  }
}

/** Check if a mode is currently in a cold streak (read-only, for UI). */
export async function getStreakStates(): Promise<StreakState[]> {
  try {
    const sb = getSupabase();
    const { data } = await sb
      .from('strategy_streak_state')
      .select('mode, is_cold, entered_cold_at, rolling_win_rate')
      .order('mode');
    return (data ?? []) as StreakState[];
  } catch {
    return [];
  }
}
