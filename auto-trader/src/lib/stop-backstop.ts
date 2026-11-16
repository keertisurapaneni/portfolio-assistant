/**
 * Stop-loss backstop — pure decision logic (no IB / DB access, unit-testable).
 *
 * WHY THIS EXISTS (Nov 5–6 2026):
 *   Swing positions are protected ONLY by the GTC STP child order inside the IB bracket.
 *   On Nov 5 (SPY −4%) the auto-trader was healthy and logging all day, yet UNH/AMZN/ADBE
 *   traded below their stop levels for hours without the IB stop firing. All four stops
 *   then released within 2 seconds at 9:45:07 AM the next morning, filling gaps lower:
 *   UNH lost ~$396/leg (~13R) instead of ~$30 (1R). 7 late stops in 60 days cost ~$932
 *   of excess loss. Nothing in the software noticed the breach.
 *
 * WHAT IT DOES:
 *   Every few minutes during regular hours, for each open swing leg, check whether the
 *   live price is beyond the stop by more than a small buffer. If that breach persists
 *   for a minimum time (long enough that a healthy IB stop would already have filled),
 *   the caller cancels the bracket children and market-closes exactly the held quantity.
 *
 * SAFETY (see .cursor/rules/ib-paper-account.mdc rule 5 — never oversell):
 *   - A breach must be PERSISTENT (BreachTracker) so we never race a stop that is
 *     filling right now.
 *   - Quantity is always allocated from the *fresh* IB position, leg by leg, and never
 *     exceeds what IB reports as held (planBackstopClose). Split T1/T2 legs of the same
 *     ticker share one IB position — we never sell the full position once per leg.
 */

/** Price must be this far beyond the stop before we call it a breach (0.3%). */
export const BACKSTOP_BREACH_BUFFER_PCT = 0.003;

/** Breach must persist at least this long before acting (a healthy IB stop fills in seconds). */
export const BACKSTOP_PERSIST_MS = 4 * 60 * 1000;

/** If we have not observed a ticker for this long, forget its breach history. */
export const BACKSTOP_STALE_MS = 20 * 60 * 1000;

export type BackstopSignal = 'BUY' | 'SELL';

/**
 * True when `price` is beyond `stop` (in the losing direction) by more than `bufferPct`.
 * Long (BUY): price <= stop * (1 - buffer).  Short (SELL): price >= stop * (1 + buffer).
 * Invalid inputs (non-finite / non-positive) never count as a breach.
 */
export function isStopBreached(
  signal: BackstopSignal,
  price: number | null | undefined,
  stop: number | null | undefined,
  bufferPct: number = BACKSTOP_BREACH_BUFFER_PCT,
): boolean {
  if (price == null || stop == null) return false;
  if (!Number.isFinite(price) || !Number.isFinite(stop)) return false;
  if (price <= 0 || stop <= 0) return false;
  return signal === 'BUY'
    ? price <= stop * (1 - bufferPct)
    : price >= stop * (1 + bufferPct);
}

export type BreachDecision = 'clear' | 'watching' | 'act';

/**
 * Tracks how long each key (ticker) has been continuously in breach.
 * Time is injected so tests are deterministic.
 */
export class BreachTracker {
  private firstSeen = new Map<string, number>();
  private lastSeen = new Map<string, number>();

  constructor(
    private readonly persistMs: number = BACKSTOP_PERSIST_MS,
    private readonly staleMs: number = BACKSTOP_STALE_MS,
  ) {}

  /** Record an observation. Returns what the caller should do. */
  observe(key: string, breached: boolean, now: number): BreachDecision {
    if (!breached) {
      this.firstSeen.delete(key);
      this.lastSeen.delete(key);
      return 'clear';
    }
    const last = this.lastSeen.get(key);
    // Gap in observations (scheduler paused, IB disconnected…) → restart the clock.
    if (last != null && now - last > this.staleMs) this.firstSeen.delete(key);
    this.lastSeen.set(key, now);

    const first = this.firstSeen.get(key);
    if (first == null) {
      this.firstSeen.set(key, now);
      return 'watching';
    }
    return now - first >= this.persistMs ? 'act' : 'watching';
  }

  /** Forget a key (after acting, or when the position is gone). */
  reset(key: string): void {
    this.firstSeen.delete(key);
    this.lastSeen.delete(key);
  }

  /** Milliseconds the key has been in breach, or 0. */
  breachAgeMs(key: string, now: number): number {
    const first = this.firstSeen.get(key);
    return first == null ? 0 : Math.max(0, now - first);
  }
}

export interface BackstopLeg {
  id: string;
  quantity: number;
}

export interface BackstopAllocation {
  legId: string;
  quantity: number;
}

/**
 * Allocate close quantities to legs from the live IB position.
 *
 * - `ibPosition` is signed (long > 0, short < 0) and must match `signal`'s direction,
 *   otherwise nothing is allocated (IB disagrees with paper_trades → reconciliation's job,
 *   never ours to "fix" with an order).
 * - Each leg gets min(leg.quantity, remaining IB shares). The sum never exceeds |ibPosition|.
 * - Legs are processed in the given order; fractional / non-positive quantities are skipped.
 */
export function planBackstopClose(
  signal: BackstopSignal,
  legs: BackstopLeg[],
  ibPosition: number,
): BackstopAllocation[] {
  if (!Number.isFinite(ibPosition) || ibPosition === 0) return [];
  const directionOk = signal === 'BUY' ? ibPosition > 0 : ibPosition < 0;
  if (!directionOk) return [];

  let remaining = Math.floor(Math.abs(ibPosition));
  const out: BackstopAllocation[] = [];
  for (const leg of legs) {
    if (remaining <= 0) break;
    const want = Math.floor(leg.quantity);
    if (!Number.isFinite(want) || want <= 0) continue;
    const qty = Math.min(want, remaining);
    out.push({ legId: leg.id, quantity: qty });
    remaining -= qty;
  }
  return out;
}
