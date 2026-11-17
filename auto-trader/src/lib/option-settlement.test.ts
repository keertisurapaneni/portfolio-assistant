/**
 * Run: npx tsx src/lib/option-settlement.test.ts
 */
import {
  intrinsicPerShare,
  invertedSpreadPayoffPerShare,
  invertedSpreadSettledPnl,
  parseDebitFromHoldNote,
  pickExpiryClose,
  isExpiryCloseFinal,
} from './option-settlement.js';

let failed = 0;
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed++; console.error(`FAIL ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
  else console.log(`ok   ${name}`);
}
function near(name: string, actual: number, expected: number, tol = 0.01): void {
  if (Math.abs(actual - expected) > tol) { failed++; console.error(`FAIL ${name}: got ${actual}, expected ${expected}`); }
  else console.log(`ok   ${name}`);
}

// intrinsic
eq('put ITM', intrinsicPerShare('P', 100, 90), 10);
eq('put OTM', intrinsicPerShare('P', 100, 110), 0);
eq('call ITM', intrinsicPerShare('C', 100, 112), 12);
eq('call OTM', intrinsicPerShare('C', 100, 90), 0);

// Inverted bull-put (put debit spread): long 85 put, short 60 put, paid 11.90, 8 contracts.
// Stock far below both strikes -> payoff = full width 25 -> (25 - 11.9) * 100 * 8 = 10,480
near('GFS-like deep ITM', invertedSpreadSettledPnl({ right: 'P', intendedShortStrike: 85, intendedLongStrike: 60, debitPerShare: 11.9, contracts: 8, spot: 40 }), 10_480);
// Stock above both strikes -> both worthless -> lose the whole debit
near('both OTM loses debit', invertedSpreadSettledPnl({ right: 'P', intendedShortStrike: 85, intendedLongStrike: 60, debitPerShare: 11.9, contracts: 8, spot: 120 }), -9_520);
// Between strikes: long 85 put worth 85-70=15, short 60 put worthless
eq('between strikes payoff', invertedSpreadPayoffPerShare({ right: 'P', intendedShortStrike: 85, intendedLongStrike: 60, spot: 70 }), 15);
// Exactly at the higher strike -> worthless
eq('at higher strike', invertedSpreadPayoffPerShare({ right: 'P', intendedShortStrike: 85, intendedLongStrike: 60, spot: 85 }), 0);
// Inverted bear-call: intended short 240 call (actually long), intended long 260 call (actually short)
eq('call inverted ITM', invertedSpreadPayoffPerShare({ right: 'C', intendedShortStrike: 240, intendedLongStrike: 260, spot: 300 }), 20);
eq('call inverted between', invertedSpreadPayoffPerShare({ right: 'C', intendedShortStrike: 240, intendedLongStrike: 260, spot: 250 }), 10);

// parse
eq('parse debit', parseDebitFromHoldNote('BEAR_PUT_DEBIT_HOLD | entry filled as net debit $11.90/sh (order #65737) — auto-close blocked'), 11.9);
eq('parse none', parseDebitFromHoldNote('something else'), null);
eq('parse null', parseDebitFromHoldNote(null), null);
eq('parse zero', parseDebitFromHoldNote('net debit $0.00/sh'), null);

// expiry close picking
const bars = [
  { date: '2026-10-14', close: 50 },
  { date: '2026-10-15', close: 51 },
  { date: '2026-10-16', close: 52 },
  { date: '2026-10-19', close: 53 },
];
eq('exact day', pickExpiryClose(bars, '2026-10-16'), 52);
eq('weekend expiry falls back to Friday', pickExpiryClose(bars, '2026-10-17'), 52);
eq('never uses a later bar', pickExpiryClose(bars, '2026-10-15'), 51);
eq('too stale -> null', pickExpiryClose([{ date: '2026-10-01', close: 9 }], '2026-10-16'), null);
eq('empty -> null', pickExpiryClose([], '2026-10-16'), null);
eq('bad close ignored', pickExpiryClose([{ date: '2026-10-16', close: 0 }], '2026-10-16'), null);

// finality
eq('not final mid-session', isExpiryCloseFinal('2026-10-16', Date.parse('2026-10-16T15:00:00Z')), false);
eq('final after close', isExpiryCloseFinal('2026-10-16', Date.parse('2026-10-16T22:00:00Z')), true);
eq('final days later', isExpiryCloseFinal('2026-10-16', Date.parse('2026-11-17T14:00:00Z')), true);

if (failed) { console.error(`\n${failed} test(s) failed`); process.exit(1); }
console.log('\nAll option-settlement tests passed');
