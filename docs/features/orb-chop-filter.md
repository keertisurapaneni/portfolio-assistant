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
