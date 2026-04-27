/**
 * SPX $50 Key-Level Breakout-Retest Scanner
 *
 * Somesh's strategy — SPY day trades built on SPX 5-min structure:
 * Includes an ORB (Opening Range Breakout) chop gate: a retest signal is
 * suppressed if SPX is still trading inside its 15-min opening range,
 * since that indicates choppy, non-directional conditions.
 *
 *   1. Identify $50 key levels on SPX (5500, 5550, 5600, 5650, …).
 *   2. Wait for a 5-min candle to CLOSE on one side of the level (the "break" candle).
 *   3. The next TWO completed 5-min candles must NOT touch the level at all
 *      (neither high nor low crosses back through the level — "independent" candles).
 *   4. When price returns to the level (retest), enter SPY in the direction of the break:
 *      - BUY  if the level was broken to the upside   → stop below the level
 *      - SELL if the level was broken to the downside  → stop above the level
 *   5. Target: the next $50 level in the direction of the breakout.
 *
 * State machine (per level, resets at midnight ET):
 *
 *   idle
 *    └─ first 5-min candle closes beyond the level
 *       └─ break_detected
 *           └─ candle 1 doesn't touch the level  →  independent_1
 *               └─ candle 2 doesn't touch the level  →  confirmed
 *                   └─ price retest touches the level  →  TRIGGERED  (generate SPY signal)
 *                   └─ price blows through without a clean retest  →  invalidated
 *
 * Integration:
 *   Call `checkSpxLevelSetups()` inside the main scheduler cycle.
 *   It returns triggered setups that should be executed as SPY DAY_TRADE orders.
 *   Once a setup fires, it is marked done and won't re-trigger the same day.
 */

import { fetchOrb } from './orb.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface Bar5m {
  ts: number;   // Unix epoch seconds (bar open time)
  open: number;
  high: number;
  low: number;
  close: number;
}

type LevelPhase =
  | 'idle'
  | 'break_detected'   // break candle confirmed; watching for independent candles
  | 'independent_1'    // first post-break candle didn't touch the level
  | 'confirmed'        // two independent candles — now watching for retest
  | 'triggered'        // retest touched the level → signal generated
  | 'invalidated';     // retest failed (close through level) or blew past without retesting

interface LevelState {
  level: number;
  phase: LevelPhase;
  direction: 'ABOVE' | 'BELOW' | null; // which side the break went
  breakBarTs: number;                   // timestamp of the break candle
  independentCount: number;
  lastProcessedBarTs: number;
}

export interface SpxSetup {
  spxLevel: number;
  direction: 'ABOVE' | 'BELOW';  // break direction
  signal: 'BUY' | 'SELL';        // trade direction for SPY
  spyEntry: number;               // SPY price at trigger (live quote)
  spyStop: number;                // SPY stop loss
  spyTarget: number;              // SPY target (next key level)
  riskReward: string;
  description: string;
}

// ── Module state ─────────────────────────────────────────────────────────

// Map from level (e.g. 5700) → current state machine state.
// Persists in process memory across scheduler cycles; resets each trading day.
const _levelStates = new Map<number, LevelState>();
let _lastResetDate = '';   // 'YYYY-MM-DD' in ET

// ── Constants ────────────────────────────────────────────────────────────

const LEVEL_STEP = 50;                // $50 key levels on SPX
const TOUCH_BUFFER_SPX = 5;          // within 5 SPX pts = "touching the level"
const LEVELS_TO_WATCH = 6;           // watch 3 levels above + 3 levels below current price
const SPX_TO_SPY = 10;               // SPX/10 ≈ SPY (rough; used only for stop/target)
const SPY_STOP_BUFFER = 1.0;         // $1.0 on SPY beyond the level = stop distance
const INVALIDATION_BARS_MAX = 20;    // if retest hasn't happened in 20 bars (100 min), give up

// ── Yahoo Finance fetch ────────────────────────────────────────────────

async function fetchSpx5mBars(): Promise<Bar5m[] | null> {
  try {
    // %5EGSPC = ^GSPC = SPX index
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=2d&interval=5m&includePrePost=false';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)' },
    });
    if (!res.ok) {
      console.warn(`[SpxScanner] Yahoo ^GSPC fetch failed: ${res.status}`);
      return null;
    }
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const timestamps: number[] = result.timestamps ?? result.timestamp ?? [];
    const q = result.indicators?.quote?.[0] ?? {};
    const opens:  (number | null)[] = q.open  ?? [];
    const highs:  (number | null)[] = q.high  ?? [];
    const lows:   (number | null)[] = q.low   ?? [];
    const closes: (number | null)[] = q.close ?? [];

    const bars: Bar5m[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = opens[i], h = highs[i], l = lows[i], c = closes[i];
      if (o != null && h != null && l != null && c != null) {
        bars.push({ ts: timestamps[i], open: o, high: h, low: l, close: c });
      }
    }
    // Only return today's bars (filter to current ET session)
    const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const todayMidnightEtMs = new Date(
      etNow.getFullYear(), etNow.getMonth(), etNow.getDate(), 0, 0, 0
    ).getTime();
    return bars.filter(b => b.ts * 1000 >= todayMidnightEtMs);
  } catch (err) {
    console.warn('[SpxScanner] Error fetching SPX bars:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function fetchSpyPrice(): Promise<number | null> {
  try {
    const url = 'https://query2.finance.yahoo.com/v7/finance/quote?symbols=SPY&fields=regularMarketPrice';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioAssistant/1.0)' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const price = data?.quoteResponse?.result?.[0]?.regularMarketPrice as number | undefined;
    return price ?? null;
  } catch {
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function getEtDateString(): string {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** Return the nearest $50 levels around `price`: 3 above and 3 below. */
function nearbyLevels(price: number): number[] {
  const base = Math.floor(price / LEVEL_STEP) * LEVEL_STEP;
  const levels: number[] = [];
  for (let i = -3; i <= 3; i++) {
    levels.push(base + i * LEVEL_STEP);
  }
  return levels;
}

function initLevel(level: number): LevelState {
  return {
    level,
    phase: 'idle',
    direction: null,
    breakBarTs: 0,
    independentCount: 0,
    lastProcessedBarTs: 0,
  };
}

/** Determine if a bar "touches" the level (wick or body crosses within buffer). */
function barTouchesLevel(bar: Bar5m, level: number): boolean {
  return bar.low <= level + TOUCH_BUFFER_SPX && bar.high >= level - TOUCH_BUFFER_SPX;
}

/** SPY stop price given the SPX level and break direction. */
function spyStop(spxLevel: number, direction: 'ABOVE' | 'BELOW'): number {
  // Convert SPX level to approximate SPY equivalent, then add a $1 buffer beyond it.
  const spyLevel = spxLevel / SPX_TO_SPY;
  return direction === 'ABOVE'
    ? parseFloat((spyLevel - SPY_STOP_BUFFER).toFixed(2))  // stop below for BUY
    : parseFloat((spyLevel + SPY_STOP_BUFFER).toFixed(2)); // stop above for SELL
}

/** SPY target price: next $50 level in the break direction. */
function spyTarget(spxLevel: number, direction: 'ABOVE' | 'BELOW'): number {
  const nextSpxLevel = direction === 'ABOVE' ? spxLevel + LEVEL_STEP : spxLevel - LEVEL_STEP;
  return parseFloat((nextSpxLevel / SPX_TO_SPY).toFixed(2));
}

// ── State machine ─────────────────────────────────────────────────────────

/**
 * Advance the state machine for one level through newly seen bars.
 * Returns `true` if the level just triggered (retest confirmed).
 */
function advanceLevelState(state: LevelState, bars: Bar5m[]): boolean {
  // Only process bars we haven't seen yet (strictly after lastProcessedBarTs)
  const newBars = bars.filter(b => b.ts > state.lastProcessedBarTs);
  if (newBars.length === 0) return false;

  let triggered = false;

  for (const bar of newBars) {
    state.lastProcessedBarTs = bar.ts;

    if (state.phase === 'triggered' || state.phase === 'invalidated') {
      break;
    }

    if (state.phase === 'idle') {
      // Look for a candle that closes BEYOND the level (breakout)
      if (bar.close > state.level + TOUCH_BUFFER_SPX) {
        // Bullish break: closed above
        state.phase = 'break_detected';
        state.direction = 'ABOVE';
        state.breakBarTs = bar.ts;
        state.independentCount = 0;
        console.log(`[SpxScanner] Level ${state.level}: BREAK ABOVE detected (bar close=${bar.close.toFixed(0)})`);
      } else if (bar.close < state.level - TOUCH_BUFFER_SPX) {
        // Bearish break: closed below
        state.phase = 'break_detected';
        state.direction = 'BELOW';
        state.breakBarTs = bar.ts;
        state.independentCount = 0;
        console.log(`[SpxScanner] Level ${state.level}: BREAK BELOW detected (bar close=${bar.close.toFixed(0)})`);
      }
      continue;
    }

    if (state.phase === 'break_detected' || state.phase === 'independent_1') {
      // Counting independent candles that don't touch the level
      if (bar.ts === state.breakBarTs) continue; // skip the break candle itself

      const touches = barTouchesLevel(bar, state.level);
      if (!touches) {
        state.independentCount++;
        if (state.independentCount === 1) {
          state.phase = 'independent_1';
          console.log(`[SpxScanner] Level ${state.level}: independent candle 1 ✓`);
        } else if (state.independentCount >= 2) {
          state.phase = 'confirmed';
          console.log(`[SpxScanner] Level ${state.level}: 2 independent candles ✓ — WATCHING FOR RETEST`);
        }
      } else {
        // Level was touched → break was not clean; reset to idle
        console.log(`[SpxScanner] Level ${state.level}: independent candle touched level — RESET`);
        state.phase = 'idle';
        state.direction = null;
        state.independentCount = 0;
        state.breakBarTs = 0;
      }
      continue;
    }

    if (state.phase === 'confirmed') {
      const barsAfterConfirm = bars.filter(b => b.ts >= state.breakBarTs).length;
      if (barsAfterConfirm > INVALIDATION_BARS_MAX) {
        console.log(`[SpxScanner] Level ${state.level}: retest window expired — INVALIDATED`);
        state.phase = 'invalidated';
        break;
      }

      const touches = barTouchesLevel(bar, state.level);
      if (touches) {
        // Retest! Check it's a genuine touch and not a blowthrough:
        // For ABOVE break (BUY): the bar's low should touch the level but close should still be above (or at least near)
        // For BELOW break (SELL): the bar's high should touch the level but close should still be below
        const isCleanRetest = state.direction === 'ABOVE'
          ? bar.close >= state.level - TOUCH_BUFFER_SPX * 2  // close still near/above level
          : bar.close <= state.level + TOUCH_BUFFER_SPX * 2; // close still near/below level

        if (isCleanRetest) {
          state.phase = 'triggered';
          triggered = true;
          console.log(`[SpxScanner] Level ${state.level}: RETEST TRIGGERED (dir=${state.direction}, bar close=${bar.close.toFixed(0)})`);
        } else {
          // Blew through without holding the level — invalidate
          state.phase = 'invalidated';
          console.log(`[SpxScanner] Level ${state.level}: retest blew through — INVALIDATED`);
        }
        break;
      }
    }
  }

  return triggered;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Run the SPX key-level scanner for the current cycle.
 *
 * Returns an array of triggered setups (usually 0 or 1 per cycle).
 * Each setup should be executed as a SPY DAY_TRADE order by the caller.
 *
 * The scanner maintains in-memory state across calls:
 *   - Level states reset at midnight ET each trading day.
 *   - A level can only trigger once per trading day.
 */
export async function checkSpxLevelSetups(): Promise<SpxSetup[]> {
  // Daily reset
  const today = getEtDateString();
  if (today !== _lastResetDate) {
    _levelStates.clear();
    _lastResetDate = today;
    console.log('[SpxScanner] Daily state reset');
  }

  const bars = await fetchSpx5mBars();
  if (!bars || bars.length < 5) {
    console.log(`[SpxScanner] Insufficient SPX bars (${bars?.length ?? 0}) — skipping`);
    return [];
  }

  const currentSpx = bars[bars.length - 1].close;
  const levels = nearbyLevels(currentSpx);

  // Initialise any new levels
  for (const level of levels) {
    if (!_levelStates.has(level)) {
      _levelStates.set(level, initLevel(level));
    }
  }

  // Remove levels that are now far from current price (cleanup stale state)
  for (const level of _levelStates.keys()) {
    if (!levels.includes(level)) {
      _levelStates.delete(level);
    }
  }

  const triggered: SpxSetup[] = [];

  for (const [level, state] of _levelStates.entries()) {
    if (state.phase === 'triggered' || state.phase === 'invalidated') continue;

    const justTriggered = advanceLevelState(state, bars);

    if (justTriggered && state.direction) {
      // ORB chop gate: if SPX itself is still inside its 15-min opening range,
      // there's no directional conviction yet — suppress the signal.
      // fetchOrb uses ^GSPC (same data source as the scanner bars).
      const spxOrb = await fetchOrb('^GSPC');
      if (spxOrb && spxOrb.status !== 'not_ready') {
        const orbBlocked =
          spxOrb.status === 'inside' ||
          (state.direction === 'ABOVE' && spxOrb.status === 'below') ||
          (state.direction === 'BELOW' && spxOrb.status === 'above');
        if (orbBlocked) {
          console.log(
            `[SpxScanner] Level ${level}: triggered but SPX ORB says ${spxOrb.status} ` +
            `(dir=${state.direction}) — suppressed (choppy / misaligned)`
          );
          // Don't mark as invalidated — let it re-check next cycle in case ORB breaks out
          state.phase = 'confirmed';
          continue;
        }
      }

      const spyPrice = await fetchSpyPrice();
      if (!spyPrice) {
        console.warn(`[SpxScanner] Level ${level}: triggered but could not fetch SPY price — skipping`);
        continue;
      }

      const signal: 'BUY' | 'SELL' = state.direction === 'ABOVE' ? 'BUY' : 'SELL';
      const stop  = spyStop(level, state.direction);
      const target = spyTarget(level, state.direction);
      const riskAmt = Math.abs(spyPrice - stop);
      const rewardAmt = Math.abs(target - spyPrice);
      const rrNum = riskAmt > 0 ? (rewardAmt / riskAmt).toFixed(1) : '?';

      triggered.push({
        spxLevel: level,
        direction: state.direction,
        signal,
        spyEntry: parseFloat(spyPrice.toFixed(2)),
        spyStop: stop,
        spyTarget: target,
        riskReward: `${rrNum}:1`,
        description:
          `SPX ${state.direction === 'ABOVE' ? 'broke above' : 'broke below'} ${level} ` +
          `→ retest confirmed → ${signal} SPY @ $${spyPrice.toFixed(2)} ` +
          `(stop $${stop}, target $${target}, R:R ${rrNum}:1)`,
      });

      // Only allow LEVELS_TO_WATCH/2 setups per cycle to avoid flooding
      if (triggered.length >= 2) break;
    }
  }

  if (triggered.length > 0) {
    console.log(`[SpxScanner] ${triggered.length} setup(s) triggered this cycle`);
  }

  return triggered;
}
