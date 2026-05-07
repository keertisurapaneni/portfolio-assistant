# ORB Chop Filter (Opening Range Breakout)

> Implemented 2026-04-27 · `auto-trader/src/lib/orb.ts`

## Overview

The Opening Range Breakout (ORB) filter is a **chop gate** — it prevents the auto-trader from entering day trades when a stock is still stuck inside its 15-minute opening range, where price action is typically indecisive and unprofitable.

Somesh's insight: most traders use ORB *to enter*; he uses it *to avoid entering*. A stock inside its ORB is churning. Wait for it to commit.

---

## What is the Opening Range?

The **first 15 minutes** of the regular trading session (9:30–9:45 AM ET) form the opening range:

```
ORB High = max(high of 9:30, 9:35, 9:40 candles)
ORB Low  = min(low  of 9:30, 9:35, 9:40 candles)
```

Three possible states thereafter:

| Status | Meaning | Trade action |
|--------|---------|--------------|
| `above` | Price closed above ORB high | Uptrend started → BUY ideas OK |
| `below` | Price closed below ORB low  | Downtrend started → SELL ideas OK |
| `inside` | Price between ORB low and high | Choppy → **skip all day trades** |
| `not_ready` | Fewer than 3 bars completed | Before 9:45 AM → gate skipped |

---

## How It's Applied

### 1. Day trade execution gate (`scheduler.ts → executeScannerTrade`)

Before placing any `DAY_TRADE` scanner order, the ticker's ORB is checked:
- If `inside` → skip with reason `inside_orb`
- If `below` and signal is `BUY` → skip (no bullish momentum)
- If `above` and signal is `SELL` → skip (no bearish momentum)
- If data unavailable or `not_ready` → proceed (gate is never a hard blocker on failure)

The check runs for all scanner-sourced day trades. Influencer signals and Suggested Finds are exempt (they have their own entry logic).

**Retryable skip**: `inside_orb` is a time-dependent condition — the ticker is **not** marked as permanently processed. It will be re-evaluated in every subsequent scheduler cycle because stocks break out of their opening range throughout the day. This also applies to other market-condition-based skips (`illiquid`, `rr_*`, `price_too_far`, `swing_chop`, `swing_low_volume`, `swing_volume_divergence`). See `isRetryableSkip()` in `scheduler.ts`.

> **Bug fixed 2026-05-07**: Previously, `inside_orb` skips permanently marked the ticker as processed, meaning a stock blocked at 9:45 AM (when VWAP data was insufficient for reclaim detection) would never be retried — even if it broke out of its ORB hours later. This caused zero day trades on choppy-open days.

### 2. SPX level scanner gate (`spx-level-scanner.ts → checkSpxLevelSetups`)

When an SPX breakout-retest setup triggers, the SPX index itself is checked against its ORB before generating a SPY order:
- If SPX is `inside` its ORB → signal suppressed (re-evaluated next cycle)
- If SPX `status` is opposite to the break direction → signal suppressed
- If SPX breaks out of ORB later that session, the setup re-fires naturally

This prevents the level scanner from firing during the first chaotic minutes of the session when SPX hasn't yet committed to a direction.

---

## Implementation

| Component | Detail |
|-----------|--------|
| File | `auto-trader/src/lib/orb.ts` |
| Data source | Yahoo Finance `range=1d&interval=5m` (same endpoint as intraday volume check) |
| Cache | In-memory, 5-min TTL per ticker — avoids redundant API calls within a cycle |
| Failure behavior | Returns `null` → callers proceed (non-blocking) |
| Key export | `fetchOrb(symbol)` → `OrbResult \| null` |
| Helper export | `isInsideOrb(symbol, direction)` → `boolean` (convenience wrapper) |

---

## Examples (from Somesh's video)

- **MERA**: broke above ORB → clean uptrend. Entry valid.
- **QQQ**: sat inside ORB most of the session → choppy. The moment it broke out, trend started.
- **SPICE**: choppy inside ORB, clean trend once it broke.
- **NVIDIA**: inside ORB all morning → choppy. Break → exploded up.

---

## Tuning

The ORB window is fixed at **3 bars (15 minutes)** — this is Somesh's explicit rule and a widely-used standard. It is not configurable at runtime; change `Math.min(3, validCount)` in `orb.ts` if you want to experiment with wider windows.

The 5-min cache TTL (`CACHE_TTL_MS`) can be adjusted independently of the main scheduler interval.
