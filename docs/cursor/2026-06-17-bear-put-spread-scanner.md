# Bear Put Spread Scanner — Implementation Plan

**Date:** June 17, 2026  
**Status:** PLAN LOCKED — ready to implement when directed  
**Origin:** 4 accidental Bear Put Debit Spread positions on Jun 17 made $4,947 net profit (biggest day ever). Decision: build this intentionally.  
**Strategy confirmed via:** Jake's YouTube (debit spreads basics) + OptionsPlay webinar (Tony Zhang / Jessica Inscip — best practices)

---

## What We're Building

A scanner that identifies stocks likely to fall and automatically places **Bear Put Spreads** (Bear Put Debit Spreads):
- **Buy** a higher-strike put (50–60 delta, near ATM)
- **Sell** a lower-strike put (20 delta, ~1 standard deviation down)
- Net **debit** paid upfront
- Profits when the underlying stock falls below the long (higher) put strike

> Bear Put = always Debit. Bull Put = always Credit. The debit/credit is implied by the direction — no need to specify separately.

---

## Why It Works

| | Bull Put Credit (existing) | Bear Put (new) |
|---|---|---|
| Direction bet | Stock stays flat or rises | Stock falls significantly |
| Capital flow | Receive premium upfront | Pay debit upfront |
| IV preference | High IV (IVR ≥ 30) | Low IV (IVR < 50) — debit is cheaper |
| Edge | Theta decay + flat market | Momentum reversal from overbought |
| IB API support | ✅ Already works | ✅ Same `placeVerticalSpreadOrder` |

IV partially cancels out in debit spreads (both legs offset each other) — so IV is less critical than for credit spreads.

---

## Watchlist

**Separate Bear Put watchlist** — do NOT reuse the Bull Put watchlist.

The Bull Put list contains stocks you're comfortable owning or being neutral on. The Bear Put list needs different names:

- High beta stocks (beta > 1.2)
- Momentum/growth stocks prone to sharp reversals
- Recently overextended stocks (far above 20-day MA)
- Weak relative strength names
- Stocks that have rallied sharply into resistance
- Stocks vulnerable to pullbacks

Overlap with the 47-ticker Bull Put list is allowed, but the Bear Put list should be curated separately and seeded with names known for sharp, fast moves (e.g. RKLB, NOW, NVDA, TSLA, MSTR, COIN, etc.).

---

## Entry Signal

### Step 1 — Scanner Scan (runs every morning, surfaces candidates)

Ticker must pass ALL of these:

| Signal | Threshold | Notes |
|---|---|---|
| RSI(14) | > 70 within last 5 trading days | Overbought momentum |
| Price vs 20 SMA | Above 20-day moving average | Extended / overextended |
| Beta | > 1.2 | High-beta names snap back harder |
| IVR | < 50 | Debit is reasonably priced |
| SPY direction | SPY not up > 1.5% today | Broad market tailwind for bears |

### Step 2 — Confirmation Trigger (required before placing order)

RSI alone is not enough — stock must also show a technical breakdown:

**At least ONE of these must be true at entry:**
- Price closes **below prior day's low** (breakdown confirmation)
- Price closes **below 5-day EMA** (short-term momentum shift)
- Volume is **above 20-day average volume** on a down move (conviction)
- Relative strength is **weakening** (stock lagging its sector ETF)

> This two-step approach avoids entering Bear Puts on overbought stocks that are still in uptrend — you wait for the actual turn.

### Hard Gates (must ALL pass)

- Max 3 simultaneous Bear Put positions open
- Max debit per spread: $800
- No entry if the same ticker already has an open Bear Put position

---

## Strike Selection (Delta-Based — OptionsPlay Best Practice)

| Leg | Delta | Notes |
|---|---|---|
| Long put (buy) | 50–60 delta | At or slightly in the money |
| Short put (sell) | 20 delta | ~1 standard deviation down; 80% chance stock stays above this |

**Expiry:** Nearest expiry with **30–60 DTE**

**Max debit rule:** If natural ask > $8 per share ($800 for 1 contract), skip — risk/reward is unfavorable.

**Spread width sanity check:** Short put should be at least $10 below long put. If the 20-delta strike is less than $10 away, reject and skip.

---

## Position Management

### Close Rules (first hit wins — no time-based 21 DTE rule for debit spreads)

| Exit | Condition | Reason |
|---|---|---|
| **Profit target** | Spread value ≥ debit × 1.75 (75% gain) | Lock in profit when stock hits short strike |
| **Stop loss** | Spread value ≤ debit × 0.50 (50% loss) | ~85% chance you lose the rest if already down 50% |
| **DTE backstop** | DTE ≤ 3 | Emergency exit only — avoid assignment/broken spread risk |

> The 21-DTE close rule applies to credit spreads only. Bear Puts are managed on profit/loss percentages, not time.

### Multiple contracts (if scaled up later)
- At 75–100% gain: close half the position, let the rest ride to max profit
- Single contract: close the full position at 75% gain

---

## Architecture

### New File: `auto-trader/src/lib/bear-put-scanner.ts`

```
bear-put-scanner.ts
├── computeRSI(prices: number[], period = 14): number
├── getEMA(prices: number[], period = 5): number
├── isOverboughtRecently(ticker, lookback = 5): boolean    // RSI > 70 in last 5 days
├── hasBearishConfirmation(ticker): boolean                // breakdown trigger check
│     checks: close < prior day low OR close < 5EMA OR volume spike OR RS weakening
├── scanTickerForBearPut(ticker): BearPutCandidate | null
│     ├── fetch: quote, RSI, 5EMA, 20SMA, IVR, beta, volume
│     ├── apply: scanner gates (step 1) + confirmation trigger (step 2) + hard gates
│     └── compute: 50-60 delta long put strike, 20-delta short put strike, max debit
├── runBearPutScan(): void
│     ├── get Bear Put watchlist (separate from Bull Put watchlist)
│     ├── scan all tickers
│     ├── filter to max 3 candidates (rank by RSI × beta descending)
│     └── auto-place Bear Put spreads (AUTO-FIRE)
└── manageBearPutPositions(): void
      ├── fetch open BEAR_PUT paper_trades
      ├── check: 75% profit target, 50% stop loss, 3 DTE backstop
      └── place IB buy-to-close order + call recordTradeClose()
```

### Modified Files

| File | Change |
|---|---|
| `credit-spread-scanner.ts` | `manageCreditSpreadPositions()` — add branch for `spread_type='BEAR_PUT'` (inverted close logic) |
| `scheduler.ts` | Add `runBearPutScan()` to morning cron (~9:05 AM ET, after credit spread scan) |
| `scheduler.ts` | Add `manageBearPutPositions()` to 30-min position management cron |
| `ib-connection.ts` | No changes needed — `placeVerticalSpreadOrder` already supports Bear Put (longStrike > shortStrike) |

### DB Changes

- `paper_trades.spread_type`: add `'BEAR_PUT'` value (text field, no migration needed)
- New table: `bear_put_watchlist` (or reuse existing `watchlist` with a `strategy` column)

### Close Logic Inversion

```typescript
// BULL_PUT: profitable when stock stays ABOVE shortStrike (OTM)
// BEAR_PUT: profitable when stock falls BELOW longStrike (ITM)

const spreadValue = spreadType === 'BEAR_PUT'
  ? Math.max(0, longStrike - currentPrice) - Math.max(0, shortStrike - currentPrice)
  : Math.max(0, currentPrice - shortStrike) - Math.max(0, currentPrice - longStrike);

const profitPct = (spreadValue - debitPaid) / debitPaid;

if (profitPct >= 0.75) → close (profit target)
if (profitPct <= -0.50) → close (stop loss)
```

---

## Data Sources (all already available)

| Data | Source | Status |
|---|---|---|
| RSI(14) | Finnhub candles / Yahoo bars | ⚠️ Need to add `computeRSI()` |
| 5-day EMA | Yahoo 1d bars | ⚠️ Need to add `getEMA()` |
| 20-day SMA | Yahoo 1d bars | ✅ Exists |
| Prior day low | Yahoo 1d bars | ✅ Computable from existing data |
| Volume (20d avg) | Yahoo 1d bars | ✅ Computable |
| IVR | `options_iv_history` table | ✅ `getStoredIvRank()` exists |
| Beta | Finnhub fundamentals | ✅ Used in options scanner |
| Delta (for strike selection) | IB option chain | ✅ `reqContractDetails` exists |
| SPY quote | Finnhub/Yahoo | ✅ Exists |

---

## Implementation Steps (when ready to build)

1. Create `bear_put_watchlist` — seed with 15–20 high-beta momentum names
2. `bear-put-scanner.ts`: `computeRSI()`, `getEMA()`, `hasBearishConfirmation()`, `scanTickerForBearPut()`, `runBearPutScan()`
3. `bear-put-scanner.ts`: `manageBearPutPositions()` with close logic
4. `scheduler.ts`: wire both functions into cron
5. `credit-spread-scanner.ts`: add `spread_type='BEAR_PUT'` branch to position manager
6. Build verification: `npx tsc --noEmit`
7. Auto-trader restart: `npm run build` + reload LaunchAgent

---

## Expected P&L Profile

| Outcome | What it takes | Notes |
|---|---|---|
| Big win (+$3K–$6K) | Stock falls 15–25% within expiry window | Like NOW, RKLB 135/95 today |
| Small win (+$300–$800) | Stock falls but not to short strike | NBIS today |
| Loss (-$400 to -$800) | Stock stays flat or rises | Capped by max debit rule |

Max risk per position: ~$800 (enforced by max debit gate)  
Max reward per position: spread width × contracts - debit paid

This is an asymmetric payoff strategy — losses are capped, wins can be large.

---

## Key Rules Summary (quick reference)

```
Watchlist:    Separate Bear Put list — high beta, momentum, overextended names
Entry:        RSI > 70 (last 5 days) + extended above 20 SMA + breakdown confirmation
Confirmation: Close < prior day low OR < 5EMA OR volume spike OR RS weakening
IVR:          < 50 preferred (debit is cheaper; debit spreads mitigate IV effects)
Strikes:      Long put = 50-60 delta, Short put = 20 delta (1 std dev down)
Expiry:       30–60 DTE
Max debit:    $800 per spread (1 contract)
Max open:     3 simultaneous Bear Put positions
Stop loss:    Close when spread loses 50% of debit paid
Profit exit:  Close when spread gains 75% of debit paid
Backstop:     Close at DTE ≤ 3 regardless (avoid assignment risk)
No 21-DTE rule — that's for credit spreads only
```

---

*Plan finalized Jun 17, 2026. Strategy confirmed via two YouTube transcripts. Ready to implement.*
