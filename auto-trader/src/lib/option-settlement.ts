/**
 * Option settlement helpers (pure — no I/O except the optional expiry-close fetch).
 *
 * Why this exists (Nov 17 2026): credit-spread rows whose entry filled as a NET DEBIT
 * ("inverted legs", flagged BEAR_PUT_DEBIT_HOLD) were skipped forever by the manager, and
 * the existing expiry backstop assumes credit-spread math. Letting them fall into it would
 * book a fabricated profit with the wrong sign. These helpers settle them correctly.
 *
 * Row convention in paper_trades: `spread_short_strike` is the strike we INTENDED to sell,
 * `spread_long_strike` the strike we intended to buy. An inverted fill means we actually
 * BOUGHT the intended-short strike and SOLD the intended-long strike.
 */

import { fetchDailyBars } from './yahoo-finance.js';

export type OptionRight = 'P' | 'C';

/** Intrinsic value per share of a single option at a given underlying price. */
export function intrinsicPerShare(right: OptionRight, strike: number, spot: number): number {
  return right === 'P' ? Math.max(0, strike - spot) : Math.max(0, spot - strike);
}

export interface InvertedSpreadInput {
  right: OptionRight;
  /** paper_trades.spread_short_strike — strike we meant to sell, but actually BOUGHT. */
  intendedShortStrike: number;
  /** paper_trades.spread_long_strike — strike we meant to buy, but actually SOLD. */
  intendedLongStrike: number;
  /** Net debit paid per share at entry (positive number). */
  debitPerShare: number;
  contracts: number;
  /** Underlying price at expiry (expiry-day close). */
  spot: number;
}

/**
 * Settlement payoff per share of the position we actually hold (long the intended-short
 * strike, short the intended-long strike), before subtracting the entry debit.
 */
export function invertedSpreadPayoffPerShare(i: Pick<InvertedSpreadInput, 'right' | 'intendedShortStrike' | 'intendedLongStrike' | 'spot'>): number {
  return (
    intrinsicPerShare(i.right, i.intendedShortStrike, i.spot) -
    intrinsicPerShare(i.right, i.intendedLongStrike, i.spot)
  );
}

/** Total settled P&L in dollars (commissions excluded, per project convention). */
export function invertedSpreadSettledPnl(i: InvertedSpreadInput): number {
  return (invertedSpreadPayoffPerShare(i) - i.debitPerShare) * 100 * i.contracts;
}

/** Extract the net debit per share from a BEAR_PUT_DEBIT_HOLD note. Null if absent/invalid. */
export function parseDebitFromHoldNote(notes: string | null | undefined): number | null {
  if (!notes) return null;
  const m = /net debit \$(\d+(?:\.\d+)?)\/sh/.exec(notes);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Pick the expiry-day close from daily bars (YYYY-MM-DD, any order).
 * Uses the last bar on/before the expiry date, but no more than 4 calendar days earlier
 * (covers Good Friday, when monthly options expire on Thursday). Returns null otherwise —
 * callers must NOT guess a price.
 */
export function pickExpiryClose(
  bars: ReadonlyArray<{ date: string; close: number }>,
  expiryYmd: string,
): number | null {
  const expiryMs = Date.parse(`${expiryYmd}T00:00:00Z`);
  if (!Number.isFinite(expiryMs)) return null;
  let best: { date: string; close: number } | null = null;
  for (const b of bars) {
    const t = Date.parse(`${b.date}T00:00:00Z`);
    if (!Number.isFinite(t) || t > expiryMs) continue;
    if (expiryMs - t > 4 * 86_400_000) continue;
    if (!(b.close > 0)) continue;
    if (!best || b.date > best.date) best = b;
  }
  return best ? best.close : null;
}

/**
 * True once the expiry-day daily bar is final: after 21:30 UTC on the expiry date
 * (16:00 ET is 20:00Z in EDT / 21:00Z in EST; +30 min margin for the data vendor).
 */
export function isExpiryCloseFinal(expiryYmd: string, nowMs: number = Date.now()): boolean {
  const t = Date.parse(`${expiryYmd}T21:30:00Z`);
  return Number.isFinite(t) && nowMs >= t;
}

/**
 * Fetch the underlying's close on the expiry date. Null if not final yet or unavailable.
 * (Yahoo range "1y" covers any late settlement we would plausibly run.)
 */
export async function fetchExpiryDayClose(symbol: string, expiryYmd: string): Promise<number | null> {
  if (!isExpiryCloseFinal(expiryYmd)) return null;
  const bars = await fetchDailyBars(symbol, '1y');
  if (!bars?.length) return null;
  return pickExpiryClose(bars, expiryYmd);
}
