# Kay Capitals Options Scalp — Exit Strategy Design

**Date:** 2026-06-05  
**Source:** 3 Kay Capitals YouTube videos (A+ Strategy series)  
**Context:** Today all 6 scalp positions expired worthless (-$2,559) because the bot held to expiration with no partial exits. This doc captures the correct exit design from the source strategy.

---

## What Kay Capitals Actually Does

### Contract Selection (we have this right)
- Kay's rule: buy the **first OTM strike** — the strike just outside current price
- Never ITM (too expensive, delta already high), never deep OTM (needs too large a move)
- Goal: catch the option crossing OTM → ITM — that's where intrinsic value jumps

**Practical nuance:** First OTM on 0DTE is aggressive and binary — if the stock doesn't move enough, it goes to zero fast (exactly what happened today). Many experienced scalpers prefer ATM or slightly ITM for better delta, tighter spreads, more reliable fills, and residual value if the move is small.

Our `findAtmStrike` picks the closest whole-dollar strike to current price — effectively ATM, slightly more conservative than Kay's first OTM. This is acceptable and arguably safer for 0DTE.

**The critical constraint regardless of which strike:** 0DTE OTM/ATM contracts **must** have an active exit plan — partial at first level, break-even stop on runner. Holding to expiration is not a valid exit strategy for this contract type. ATM has slightly more residual value at expiry than first OTM, but both go to near-zero if the move doesn't materialize and you hold too long.

### The 90-Minute Rule
- Only trade the **first 90 minutes** (9:30–11:00 AM)
- After 11:00 AM the market gets choppy and traders give profits back
- Our scanner fires at 10:00 AM and 11:00 AM — borderline acceptable, but VWAP retest scan running until 3 PM is outside his window

### Entry Filters (in priority order)
1. NTZ break — price must break out of (yesterday's high/low + pre-market high/low) box
2. ORB retest — wait for break of 15-min opening range, then retest with **low volume**
3. VWAP confluence — price above VWAP = bullish, below = bearish
4. 200 SMA on 5-min chart — confirms direction
5. **Volume filter on retest** — retest candle volume must be LOWER than breakout candle; high retest volume = trap, skip or reverse

### Exit Strategy — "Negative Risk Management"

This is the piece our bot is missing entirely.

**With N contracts (he uses 10, we use 1–2):**

| Step | Action |
|------|--------|
| Entry | Buy N contracts at first OTM strike |
| First level hit | Sell 50% (N/2), move stop on remainder to **break-even** |
| Second level hit | Sell 50% of remainder, stop still break-even |
| Third level hit | Sell 50% of remainder again |
| Runner | Last contract(s) run to next level with zero risk (stop = break-even) |
| EOD cutoff | Hard close all remaining contracts before value disappears |

**Key principle: break-even stop after first partial**  
Once first target is hit and half is sold, the worst case on remaining contracts is break-even. This is why his losses stay small and winners get large — he's never giving back more than the original stop after the first exit.

**Levels are exits, not entries**  
"People use levels to get into a trade. I use levels to get out of a trade." — every hourly level marked pre-market becomes a profit-taking zone, not an entry signal.

**Never depend on expiration**  
He closes everything during the move. EOD is a rare safety net, not the primary exit. Options only have value while the stock is moving — once momentum stalls at a level, he's out.

---

## What Our Bot Does Today (broken)

1. Buys 1 contract at ATM strike ✓
2. Waits for 2× premium (profit target) or 0.5× premium (stop loss)
3. If neither is hit → holds all the way to EOD
4. EOD close tries to get IB Greeks → if IB disconnected, marks as $0 and closes in DB without placing sell order
5. Option expires worthless

**Result today:** 3 positions were ITM at expiry (NVDL +$757, IWM +$935, SOFI +$199) but the bot never took profits during the move. All expired at $0 because EOD close failed due to IB disconnect during auto-trader restart.

---

## What the Bot Should Do (target design)

### Contract sizing
Buy **2 contracts** instead of 1. This is the minimum needed to execute the partial exit strategy — you can't split 1 contract.

### Exit sequence
```
Entry: BUY 2 contracts @ ATM strike

First level hit (+50% premium):
  → SELL 1 contract (lock in profit)
  → Move stop on contract #2 to break-even (entry price)
  → Record partial close in DB, IB order #1

Second level hit (+100% premium):
  → SELL contract #2
  → Record full close in DB, IB order #2

EOD hard close (3:45 PM):
  → If any contracts still open: SELL at market/mid
  → This must place a real IB order, not just update DB
  → Only mark CLOSED in DB after fill confirmation
```

### EOD close fix (critical)
- `closeAllScalpPositionsEod()` exists but is **never called** (dead function)
- When IB Greeks return null (disconnected), `null?.mid ?? 0` = 0 → incorrectly assumes worthless
- Fix: treat null separately from $0 — null means IB unavailable, leave FILLED; $0 means genuinely worthless

### Volume filter (entry improvement)
Before firing a VWAP retest scalp, compare:
- Retest candle volume vs. breakout candle volume
- If retest volume > breakout volume → skip (or reverse direction)
- This would filter false signals and reduce the number of positions held to EOD

---

## Why Today's -$2,559 Loss Happened

Root cause chain:
1. Bot held all 6 positions to EOD (no partial exits during the move)
2. Auto-trader restarted multiple times → IB connection was unstable at 3:45 PM
3. `closeAllScalpPositionsEod()` was never wired into the scheduler anyway
4. `manageScalpPositions` (every 15 min) called `getOptionGreeksForContract` → IB disconnected → returned null → `null?.mid ?? 0` = 0
5. `closePremium = 0` + `daysToExpiry = 0` → code assumed all options worthless → marked DB CLOSED at $0 without placing IB sell orders
6. IB still held all 7 positions; 3 were ITM but no sell orders ever fired
7. Options expired, value lost

If partial exits had been taken during the day, most positions would have been closed or at break-even before the EOD failure mode was even reached.

---

## Current System vs Kay's Framework

| What the bot does | What Kay's framework does |
|---|---|
| Find momentum / VWAP setup | Wait for clean market structure |
| Buy one ATM option | Enter only after break + retest confirmation |
| Hold as a single position | Take partial profits at levels |
| Hope EOD logic closes it | Move stop / manage runners |
| | Be done early, never rely on expiration |

These are fundamentally different systems. The entries could be decent and still lose money if profits are not harvested. A 0DTE option can go +$300 unrealized → +$0 → -$500 very quickly with no partial exit or stop management.

---

## Implementation Plan

### Phase 1 — P0: Fix Accounting and Actual Exits (do first)

Before improving entries, fix the system so it cannot lie about position state.

**Required state model:**
```
OPEN → CLOSING_SUBMITTED → PARTIALLY_CLOSED → CLOSED
                                            → CLOSE_FAILED
```

- `Submitted sell order ≠ closed trade`
- `Filled sell order = closed trade`
- Never calculate final realized P&L until IB confirms fill price

**Required changes:**
- 2-contract minimum (can't do partials with 1)
- Partial exit at first target: sell 1, move stop on runner to break-even
- Let second contract run to next level / trailing stop / time stop
- Wire `closeAllScalpPositionsEod()` into scheduler — currently dead code
- EOD close ladder: 3:45 PM limit → 3:50 PM tighten → 3:55 PM aggressive → 3:58 PM marketable limit → 4:00 PM no open 0DTE scalps allowed
- Mark CLOSED only after IB fill confirmation, not on order submission

### Phase 2 — P1: 90-Minute Rule

Stop entering trades outside the regime Kay describes.

- Entry window: **9:45 AM – 11:00 AM ET** (maybe 11:30 AM on strong trend days)
- No new entries after 11:30 AM
- Closing logic can run later, but no new positions in the afternoon

Currently the VWAP scanner runs until 3 PM — well outside his window and in the choppy regime he explicitly warns against.

### Phase 3 — P2: ORB + NTZ + 200 SMA Entry Filters

Add entry-quality filters after exits are fixed (bad exits ruin good entries first).

**For calls — all must be true:**
- Price > ORB high (15-min opening range)
- Price > VWAP
- Price > 200 SMA (5-min chart)
- NTZ broken (outside yesterday's high/low + pre-market high/low box)
- Retest candle volume < breakout candle volume
- Next candle confirms

**For puts — mirror of the above.**

### Phase 4 — P3: Runner Logic

Once partials are working:
- Target next hourly level
- Trailing stop under/over structure
- VWAP / 8 EMA runner hold logic
- Time-based runner exit

---

## Contract Selection (keep ATM, don't chase first OTM)

Kay says "first OTM" but for automation ATM is safer:
- Better delta, tighter spreads, more reliable fills
- Liquid ATM > cheap but thin OTM for 0DTE

Keep current `findAtmStrike` behavior. Enforce:
- `spread <= max allowed`
- `bid > 0.10`
- `premium <= cap`
- `delta` in acceptable range
- Volume / open interest check

---

## Bottom Line

> For 0DTE options, exit management is not optional. It is the strategy.

The bot currently has the entry signal layer partially built but the entire exit layer missing. Fix exits first, then improve entries.
