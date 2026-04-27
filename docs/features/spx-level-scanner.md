# SPX Key-Level Breakout-Retest Scanner

> Implemented 2026-04-27 · `auto-trader/src/lib/spx-level-scanner.ts`

## Overview

A mechanical, rule-based day-trade scanner that enters SPY when SPX breaks a $50 key level cleanly and then retests it. No AI inference — every decision is deterministic from 5-minute candle structure.

This strategy was sourced from Somesh's trading framework and is well-suited to the auto-trader because:
- The setup is binary (triggered / not triggered) — no confidence ambiguity
- Entry, stop, and target are all known before the order is placed
- It runs on SPX index data (no scanner edge-function quota consumed)

---

## Strategy Rules

### Key Levels
SPX $50 levels: 5500, 5550, 5600, 5650, 5700, 5750, …

The scanner watches the 3 levels above and 3 levels below the current SPX price at any given time.

### Entry Pattern (4 steps)

```
1. BREAK — a 5-min candle closes BEYOND the level (>5 SPX pts from it)
              ↓
2. INDEPENDENT 1 — next 5-min candle does NOT touch the level (high/low stay clear)
              ↓
3. INDEPENDENT 2 — second consecutive 5-min candle also does NOT touch the level
              ↓
4. RETEST — price comes back and touches the level for the first time
            → ENTER SPY at market
```

For **ABOVE** break: trade SPY **BUY**  
For **BELOW** break: trade SPY **SELL**

### Stop Loss
- BUY:  stop = (SPX level − 10 pts) / 10 → ~$1.00 below the SPY equivalent of the level  
- SELL: stop = (SPX level + 10 pts) / 10 → ~$1.00 above the SPY equivalent of the level

### Target
Next $50 SPX level in the direction of the breakout:
- BUY at 5700 level → target = 5750 SPX → $575 SPY
- SELL at 5700 level → target = 5650 SPX → $565 SPY

### Invalidation
- Retest fails: the retest candle closes significantly through the level → setup invalidated
- Timeout: no retest within 20 bars (~100 minutes) after confirmation → setup invalidated

---

## State Machine

Each watched level runs its own independent state machine, persisted in process memory and reset at midnight ET:

```
idle
 └─ 5-min close beyond level (>5 SPX pts)
    └─ break_detected
        └─ candle 1: high/low stays clear of level
           └─ independent_1
               └─ candle 2: high/low stays clear of level
                  └─ confirmed  ──────────────────────┐
                      │                               │
                      └─ price touches level          └─ 20-bar timeout
                          ├─ close holds level → TRIGGERED      → invalidated
                          └─ close blows through → invalidated
```

A level can only fire **once per trading day**.

---

## Implementation

| Component | Detail |
|-----------|--------|
| File | `auto-trader/src/lib/spx-level-scanner.ts` |
| Data source | Yahoo Finance `^GSPC` — 5-min bars, `range=2d` |
| SPY price | Yahoo Finance v7 quote API (`regularMarketPrice`) |
| Called from | `scheduler.ts` step 11 — every main cycle during market hours |
| Execution path | Same `executeScannerTrade()` as AI scanner ideas |
| Confidence | Fixed at **9** (rule-based, not AI-estimated) |
| Mode | `DAY_TRADE` — auto-closed EOD |
| Source tag | `spx_level_scanner` |

---

## Execution Flow

```
checkSpxLevelSetups()
  │
  ├─ Fetch ^GSPC 5-min bars (Yahoo Finance)
  ├─ Compute nearby $50 levels (3 above + 3 below)
  ├─ Advance state machines for each level
  │
  └─ For each triggered setup:
       ├─ Fetch live SPY price
       ├─ Build TradeIdea { ticker: 'SPY', signal, confidence: 9, entryPrice, stopLoss, targetPrice }
       ├─ Guard: hasActiveTrade('SPY') → skip if already in a SPY trade
       ├─ Guard: isDayTradeLossGateActive() → skip if daily loss limit hit
       └─ executeScannerTrade() → placeBracketOrder() via IB Gateway
```

All standard pre-trade checks (position sizing, capital bucket limits, IB connectivity) apply automatically because the signal flows through `executeScannerTrade`.

---

## Tuning Constants

| Constant | Default | Purpose |
|----------|---------|---------|
| `LEVEL_STEP` | 50 SPX pts | Spacing between key levels |
| `TOUCH_BUFFER_SPX` | 5 pts | Wick must come within 5 pts to count as a "touch" |
| `LEVELS_TO_WATCH` | 6 | 3 above + 3 below current price |
| `SPY_STOP_BUFFER` | $1.00 | Distance beyond the SPY-equivalent level for stop placement |
| `INVALIDATION_BARS_MAX` | 20 bars | ~100 min — retest window before giving up |

---

## Notes

- SPX/SPY conversion uses the approximation `SPY ≈ SPX / 10`. The actual ratio drifts slightly over time but is close enough for stop/target placement; the actual entry fills at the live SPY market price.
- The scanner does **not** consume any LLM quota — it is purely price-structure based.
- Only one SPY position can be active at a time (enforced by `hasActiveTrade('SPY')` guard).
- The state machine resets nightly so stale patterns from prior sessions don't bleed over.
