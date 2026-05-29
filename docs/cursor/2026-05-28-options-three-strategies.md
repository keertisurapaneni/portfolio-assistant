# Options Strategies — System Documentation

**Date:** 2026-05-28  
**Status:** Active — all three strategies live in production

---

## Overview

The system runs three distinct options strategies, each with a different time horizon,
risk profile, and purpose. They are designed to work together:

| Strategy | Mode | Time Horizon | Direction | Purpose |
|---|---|---|---|---|
| **Wheel** | `OPTIONS_PUT` / `OPTIONS_CALL` | Weeks (21–60 DTE) | Neutral-bullish | Recurring premium income |
| **Scalp** | `OPTIONS_SCALP` | Same day | Directional | Intraday momentum capture |
| **LEAPs** | `OPTIONS_LEAP` | 12–18 months | Long bullish | Capital-efficient equity exposure |

---

## 1. Wheel Strategy (`OPTIONS_PUT` / `OPTIONS_CALL`)

### What it does
Sells cash-secured puts on stocks we'd happily own at a discount. If assigned, sells
covered calls on the shares to collect more premium. Self-sustaining income loop.

### Entry gates (all must pass)
1. **Watchlist** — only tickers on the curated options watchlist (STABLE / GROWTH / HIGH_VOL tiers)
2. **IV rank ≥ 50** — only sell when premium is elevated (≥25 for range-bound STABLE names)
3. **Not within 7 days of earnings** — no selling through binary events
4. **Stock above SMA50** — trend must be intact; no catching falling knives
5. **Stock not down >20% in 3 months** — avoids broken names
6. **Beta cap** — STABLE ≤1.5, GROWTH ≤1.8, HIGH_VOL ≤2.5
7. **Not within MAX_PCT from 52-week high** — need margin of safety (exempt on dip entries)
8. **Bollinger Bands** — checks whether stock is at/near lower band (better entry)
9. **RSI** — oversold + recovering adds conviction (soft signal, nudges delta up)
10. **MACD** — histogram direction adjusts delta ±0.03 (soft modifier, never blocks)
11. **SMA20 floor** — strike must be at or below the 20-day SMA (dip entries exempt)
12. **Spread ≤ 30% of mid** — liquidity gate

### Delta targeting (IV-adaptive)
The delta target is NOT fixed. It adapts to market conditions:

| Condition | Delta Target | Logic |
|---|---|---|
| VIX spike + stock near 200 DMA | 0.35 (STABLE/GROWTH), 0.20 (HIGH_VOL) | Ideal assignment entry — want to own it here |
| Bear mode / VIX elevated | 0.15–0.20 | Conservative — protect capital |
| IV rank ≥ 60 (normal market) | +0.05 bump | High IV = sell more premium |
| MACD bullish | +0.03 nudge | Trend confirming |
| MACD bearish | −0.03 nudge | Caution |
| Tier override | STABLE: 0.25, HIGH_VOL: 0.20 | Per-tier defaults |
| RSI oversold + recovering | 0.35 | High-conviction dip entry |

### Exit rules
- **50% profit capture** → buy-to-close (auto-tuned by Rule G, configurable)
- **Green day (stock up ≥1.5%)** → lower threshold to 35% (IV compresses, take profits faster)
- **Stop-loss** → premium exceeds 3× collected → close for defined loss
- **21 DTE** → hard time exit regardless of P&L
- **Early roll** → stock 3%+ below strike + premium grown 1.2× + ≥22 DTE → evaluate roll

### DTE targeting
- Default: scanner picks best expiry near 30 DTE
- IV rank ≥ 70: extends to 60 DTE (more premium at better ratio)
- Bear mode: forced to 21 DTE (fast theta, quick recovery)

---

## 2. Options Scalp (`OPTIONS_SCALP`)

### What it does
Buys ATM calls or puts for same-day intraday momentum plays. Completely separate
from the wheel — this strategy BUYS options, not sells them. Short holding time,
defined max loss, forced EOD close.

### Design principles (kaycapitals framework, applied with judgment)
- ATM options only (δ 0.40–0.60): no need to fight Greeks, option tracks stock
- Round-dollar strikes only: better liquidity, tighter spreads
- Momentum confirmation: stock must have moved >1.5% from open before entry
- Small sizing: 1 contract max, $500 premium cap, 2 trades/day max

### Entry gates
1. **IB connected** — needs live chain data for ATM strike
2. **Daily cap** — max 2 scalp trades per calendar day
3. **No open scalp on same ticker** — no stacking
4. **Intraday move ≥ 1.5%** — momentum confirmed (up → call, down → put)
5. **Round-dollar strike** — no half-dollar "beta contracts"
6. **Real bid** — bid ≥ $0.10 (liquidity check)
7. **Premium ≤ $500** — position sizing

### Exit rules
- **+100% gain** → premium doubled → auto close
- **−50% loss** → premium halved → stop out
- **3:45 PM ET** → forced EOD close regardless of P&L (never hold options overnight)

### Schedule
- Scans at **10:00 AM** and **11:00 AM ET** (after opening volatility settles)
- Position management every **15 minutes** from 10 AM to 3:45 PM
- EOD close fires inside the **3:45 PM soft-close cron** alongside day-trade close

---

## 3. LEAPs (`OPTIONS_LEAP`)

### What it does
Buys deep ITM long-dated calls (12–18 month expiry) on conviction stocks. Capital-efficient
equity exposure — controls 100 shares for ~20–25% of the cost. The freed capital runs
the wheel simultaneously.

**Frequency:** A handful per year. Only when all conditions align simultaneously.
This is NOT a weekly scanner — it fires rarely and deliberately.

### Entry gates (all must pass — strict by design)
1. **Watchlist** — HIGH_VOL + GROWTH conviction names only
2. **No existing LEAP** on this ticker
3. **IV rank < 30** — options must be genuinely cheap (tighter than wheel sell gate of 50)
4. **No earnings within 14 days** — IV crush would destroy entry premium
5. **Daily RSI ≤ 45** — oversold on the daily timeframe
6. **Weekly RSI ≤ 50** — higher timeframe must also confirm (prevents catching a falling knife mid-trend)
7. **Not within 5% of 52-week high** — meaningful support required, not ATH
8. **Options spread ≤ 5% of mid** — liquid chain only (tighter than wheel's 30% — we're paying, not collecting)
9. **Premium ≤ $2,500 per contract** — position sizing
10. **Portfolio cap** — total LEAP exposure ≤ 10% of account ($10k on $100k)

### Strike & expiry
- **Delta target:** 0.70–0.80 (deep ITM) — moves almost dollar-for-dollar with stock
- **Expiry:** ~12 months out (nearest Friday ≥ 300 DTE)
- Deep ITM means mostly intrinsic value — less extrinsic bleed, higher probability

### Exit rules
- **+100% gain** → premium doubled → take profit
- **Stock down >20% from entry** → thesis broken → close
- **DTE < 90 days** → warning fires to roll or close (alert, not auto-close)

### Schedule
- Scan: **Monday 10:30 AM ET** (alongside weekly watchlist screener)
- Position check: **Monday 11:30 AM ET** (weekly cadence matches the long-term horizon)

---

## How the three strategies work together

```
Account capital
│
├── Wheel (OPTIONS_PUT / OPTIONS_CALL) ──── Ongoing premium income
│   └── Capital tied up: strike × 100 × contracts (put capital reserved)
│   └── Freed by 50% profit-take → redeployed same day at 1:30 PM re-scan
│
├── Scalp (OPTIONS_SCALP) ─────────────── Intraday punches on momentum
│   └── Capital used: premium paid (max $500/trade, max 2/day)
│   └── EOD close guaranteed — no overnight exposure
│
└── LEAPs (OPTIONS_LEAP) ──────────────── Long-term directional exposure
    └── Capital used: premium paid (max $2,500, total cap 10% of account)
    └── Runs alongside the wheel on the same conviction stocks
    └── Freed capital from wheel premium → funds the wheel engine, not LEAP sizing
```

The strategies are intentionally non-correlated in their time horizons:
- Wheel wins from time passing (theta)
- Scalp wins from same-day directional moves (gamma)
- LEAPs win from long-term stock appreciation (delta)

---

## Key constants (quick reference)

### Wheel
| Constant | Value | File |
|---|---|---|
| `MIN_IV_RANK` | 50 | `options-scanner.ts` |
| `DEFAULT_DELTA_TARGET` | 0.30 | `options-scanner.ts` (auto-tuned) |
| `BEAR_DELTA_TARGET` | 0.15 | `options-scanner.ts` |
| `profitClosePct` | 50% (auto-tuned) | `options-manager.ts` |
| Green-day profit close | 35% | `options-manager.ts` |
| Stop-loss multiplier | 3× premium | `options-manager.ts` |

### Scalp
| Constant | Value | File |
|---|---|---|
| `INTRADAY_MOVE_MIN_PCT` | 1.5% | `options-scalp.ts` |
| `MAX_PREMIUM_PER_TRADE` | $500 | `options-scalp.ts` |
| `MAX_SCALP_TRADES_PER_DAY` | 2 | `options-scalp.ts` |
| `PROFIT_TARGET_MULT` | 2.0× (100%) | `options-scalp.ts` |
| `STOP_LOSS_MULT` | 0.5× (−50%) | `options-scalp.ts` |

### LEAPs
| Constant | Value | File |
|---|---|---|
| `MAX_IV_RANK_TO_ENTER` | 30 | `options-leap.ts` |
| `DAILY_RSI_OVERSOLD` | ≤ 45 | `options-leap.ts` |
| `WEEKLY_RSI_OVERSOLD` | ≤ 50 | `options-leap.ts` |
| `LEAP_DELTA_TARGET` | 0.72 | `options-leap.ts` |
| `LEAP_TARGET_DTE` | 365 | `options-leap.ts` |
| `LEAP_EXIT_DTE` | 90 (alert) | `options-leap.ts` |
| `MAX_OPTION_SPREAD_PCT` | 5% | `options-leap.ts` |
| `LEAP_MAX_PREMIUM` | $2,500 | `options-leap.ts` |
| Portfolio cap | 10% of account | `options-leap.ts` |

---

## Related files

```
auto-trader/src/
  lib/
    options-scanner.ts   — Wheel put/call scan logic, all gates, delta targeting
    options-manager.ts   — Wheel position management, P&L, stop/profit/roll
    options-chain.ts     — IB options chain fetch, strike selection, Greeks
    options-scalp.ts     — Scalp scan, execution, position management, EOD close
    options-leap.ts      — LEAP scan, execution, position management
  scheduler.ts           — All cron wiring for options strategies

app/src/components/PaperTrading/tabs/OptionsTab.tsx — UI (Open, Spreads, History, Watchlist, Sniper, Log)

shared/
  trade-types.ts         — TradeMode union (includes all OPTIONS_* modes)
  trade-status-sets.ts   — OPTIONS_MODES array
```
