# OPTIONS_SCALP — SPY VWAP Market Regime Gate

**Date:** Jun 29, 2026  
**PR:** #480  
**Files changed:** `auto-trader/src/lib/options-scalp.ts`

---

## Problem

All true 0DTE scalp data (Jun 2–4, 2026) showed a 100% directional split:

| Direction | Trades | Outcome | Net P&L |
|-----------|--------|---------|---------|
| PUT (SELL) | 3 | 3 wins (auto_exercised ITM) | +$325 |
| CALL (BUY) | 4 | 4 losses (expired worthless) | -$2,139 |

The market was in a downtrend June 2–4. Every VWAP reclaim → call setup failed because the broader market kept selling off — the reclaims were traps, not genuine momentum.

Kay Capitals runs this filter by eye ("trade with the tape"). We're encoding it explicitly.

---

## Decision: Absolute SPY VWAP Hard Gate

Before entering any scalp (both ORB and VWAP scanners), check SPY's price vs. its session-anchored VWAP:

- **SPY > VWAP (BULLISH)** → only CALLS allowed
- **SPY < VWAP (BEARISH)** → only PUTS allowed
- **SPY = VWAP (NEUTRAL)** → no scalps

Implemented as `getSpyRegime()` in `options-scalp.ts`, calling `fetchVwap('SPY')` which is already computed each scan cycle.

---

## Why Absolute, Not Confidence-Weighted

A roundtable discussion (Jun 29) considered confidence-weighted approach (require 2+ confirming candles, >1.5% move). Rejected because:

1. We have 10 data points — insufficient to calibrate thresholds
2. "2 candles, 1.5%" are invented numbers, not data-derived
3. The 200 SMA direction filter (ORB) is already an absolute gate — consistent pattern
4. This is a **paper account** — there is no financial risk from shipping active vs. shadow mode

---

## Falsification Threshold

Per the roundtable: if after **30+ trades** the filter-approved entries show **>40% loss rate**, revisit confidence-weighted approach (requiring SPY VWAP deviation magnitude, VIX level at entry, or candle confirmation count).

---

## Caveats

- **Sample size is tiny.** Jun 2–4 was one downtrend week. The filter fits that data perfectly. It may or may not generalize.
- **SPY VWAP crossing in choppy markets.** On oscillating days, SPY crosses VWAP multiple times. The filter will flip direction accordingly — this is intentional (we want to trade with the current micro-regime, not the morning's regime).
- **Puts can also lose.** We have no losing put data yet. The Jun 24 IWM PUT (-$430) lost despite bearish regime — but that was the 1–4 DTE bug (now fixed). True 0DTE puts in regime-aligned conditions remain 3/3.

---

## Log Output

Every blocked trade logs:
```
[Options Scalp] TICKER: CALL blocked by SPY regime (BEARISH) — skipping
[VWAP Scalp] TICKER: PUT blocked by SPY regime (BULLISH) — skipping
```

Every allowed trade logs the regime confirmation:
```
[Options Scalp] TICKER: ORB retest setup — CALL | regime BULLISH ✓ | ...
[VWAP Scalp] TICKER: ... → CALL | regime BULLISH ✓
```
