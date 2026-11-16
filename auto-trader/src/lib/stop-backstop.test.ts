/**
 * Unit tests for stop-backstop pure logic.
 * Run: npx tsx src/lib/stop-backstop.test.ts
 */
import {
  isStopBreached,
  BreachTracker,
  planBackstopClose,
  BACKSTOP_PERSIST_MS,
} from './stop-backstop.js';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function eq<T>(a: T, b: T, msg: string) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

// ── isStopBreached ───────────────────────────────────────────
// Real case: UNH long, stop 412.12. Price 407 (the 10:30 bar low) is a breach.
assert(isStopBreached('BUY', 407.18, 412.12), 'UNH 407.18 vs stop 412.12 is a breach');
assert(!isStopBreached('BUY', 412.0, 412.12), 'inside 0.3% buffer is not a breach (stop may be filling)');
assert(!isStopBreached('BUY', 415, 412.12), 'above stop is not a breach');
assert(isStopBreached('BUY', 412.12 * (1 - 0.003), 412.12), 'exactly at buffer edge counts');
// Short side mirrors
assert(isStopBreached('SELL', 105, 100), 'short: price above stop is a breach');
assert(!isStopBreached('SELL', 100.1, 100), 'short: inside buffer is not a breach');
assert(!isStopBreached('SELL', 95, 100), 'short: price below stop is fine');
// Invalid inputs never breach
assert(!isStopBreached('BUY', null, 100), 'null price');
assert(!isStopBreached('BUY', 90, null), 'null stop');
assert(!isStopBreached('BUY', 0, 100), 'zero price (quote failure) must NOT trigger a sell');
assert(!isStopBreached('BUY', NaN, 100), 'NaN price');
assert(!isStopBreached('BUY', 90, 0), 'zero stop');

// ── BreachTracker ────────────────────────────────────────────
{
  const t = new BreachTracker();
  const T0 = 1_000_000;
  eq(t.observe('UNH', true, T0), 'watching', 'first breach starts the clock');
  eq(t.observe('UNH', true, T0 + 60_000), 'watching', 'still inside persist window');
  eq(t.observe('UNH', true, T0 + BACKSTOP_PERSIST_MS), 'act', 'act once persisted');
  eq(t.observe('UNH', false, T0 + BACKSTOP_PERSIST_MS + 1), 'clear', 'recovery clears');
  eq(t.observe('UNH', true, T0 + BACKSTOP_PERSIST_MS + 2), 'watching', 'after recovery the clock restarts');
}
{
  const t = new BreachTracker();
  const T0 = 5_000_000;
  t.observe('AMZN', true, T0);
  // Scheduler/IB down for 30 min → gap longer than staleMs → do not treat as persistent.
  eq(t.observe('AMZN', true, T0 + 30 * 60_000), 'watching', 'observation gap restarts the clock');
}
{
  const t = new BreachTracker();
  t.observe('A', true, 0);
  t.observe('B', true, 1000);
  eq(t.observe('A', true, BACKSTOP_PERSIST_MS), 'act', 'A is independent of B');
  eq(t.observe('B', true, BACKSTOP_PERSIST_MS), 'watching', 'B started later');
  t.reset('A');
  eq(t.breachAgeMs('A', BACKSTOP_PERSIST_MS), 0, 'reset forgets history');
}

// ── planBackstopClose ────────────────────────────────────────
// Split T1/T2 legs of one ticker share ONE IB position — never sell it twice.
eq(
  planBackstopClose('BUY', [{ id: 't1', quantity: 16 }, { id: 't2', quantity: 16 }], 32),
  [{ legId: 't1', quantity: 16 }, { legId: 't2', quantity: 16 }],
  'two legs, exact position → each sells its own qty (total 32, not 64)',
);
eq(
  planBackstopClose('BUY', [{ id: 't1', quantity: 16 }, { id: 't2', quantity: 16 }], 20),
  [{ legId: 't1', quantity: 16 }, { legId: 't2', quantity: 4 }],
  'IB holds less than legs claim → cap to IB position, never oversell',
);
eq(
  planBackstopClose('BUY', [{ id: 't1', quantity: 16 }, { id: 't2', quantity: 16 }], 16),
  [{ legId: 't1', quantity: 16 }],
  'one leg already closed in IB → only one sells',
);
eq(planBackstopClose('BUY', [{ id: 't1', quantity: 10 }], 0), [], 'flat in IB → no order');
eq(planBackstopClose('BUY', [{ id: 't1', quantity: 10 }], -10), [], 'IB is short but trade is long → no order');
eq(planBackstopClose('SELL', [{ id: 's1', quantity: 10 }], 10), [], 'IB is long but trade is short → no order');
eq(planBackstopClose('SELL', [{ id: 's1', quantity: 10 }], -10), [{ legId: 's1', quantity: 10 }], 'short covers with positive qty');
eq(planBackstopClose('BUY', [{ id: 't1', quantity: 0 }, { id: 't2', quantity: 5 }], 10), [{ legId: 't2', quantity: 5 }], 'zero-qty leg skipped');
eq(planBackstopClose('BUY', [{ id: 't1', quantity: 10 }], NaN), [], 'NaN position → no order');
// IB holds MORE than legs claim (e.g. another tracked trade) → only sell what these legs own
eq(planBackstopClose('BUY', [{ id: 't1', quantity: 10 }], 50), [{ legId: 't1', quantity: 10 }], 'never sell more than legs own');

console.log('stop-backstop tests passed');
