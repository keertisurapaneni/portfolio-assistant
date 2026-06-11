# Kay Capitals Options Scalp — Strategy & Implementation

**Created:** 2026-06-05  
**Last updated:** 2026-06-07  
**Sources:** Kay Capitals YouTube — "My Options Strategy Is Boring", "The 3-Step A+ Options Strategy", and 3 additional strategy/walkthrough videos  

---

## The Full Kay Capitals Framework

Everything below is distilled directly from his videos. This is the strategy our bot is designed to implement.

### Pre-Market Routine (before 9:30 AM)

1. **Mark hourly levels** — go to hourly chart, extended hours ON, switch to line chart. Draw 2–3 levels above and 2–3 below current price wherever price clearly "bent" (turned, paused, or rejected) in the last few days. These are **exit zones**, not entry signals. "I use levels to get OUT of a trade."

2. **Mark NTZ (No Trading Zone)** — draw a box from:
   ```
   NTZ top    = max(pre-market high, yesterday's high)
   NTZ bottom = min(pre-market low,  yesterday's low)
   ```
   No trades while price is inside this box. "Inside NTZ is where beginners get destroyed — false breakouts, trap wicks, algorithm games."

3. **Check news calendar** — only care about market-moving events: CPI, FOMC, PMI, non-farm payrolls, or mega-cap earnings (AAPL, NVDA, TSLA). Set alarms 2 min before any event that falls during the trading window. Everything else is noise.

---

### Trading Window and Timeframes

| Time | Chart | What you're doing |
|---|---|---|
| Before 9:30 | Hourly | Mark levels + NTZ |
| 9:30–9:45 | 5-min | Wait. Let ORB form. Do nothing. |
| 9:45–10:00 | 2-min | Look for ORB breakout + retest |
| 10:00–11:00 | 5-min | Continue watching. Last entries by 11:00 AM. |
| After 11:00 | 10-min | Wind down. Market gets choppy. |

**Hard rule: no new entries after 11:00 AM.** The first 90 minutes gives the cleanest moves. After that, price chops and most traders give their profits back.

---

### The 3-Step Entry Framework

All three must pass before entering.

#### Step 1 — NTZ Break (price must be outside the box)

Price must have fully broken out of the NTZ before you even look for a trade. If SPY is ranging between yesterday's high and low, there is no trade. Wait for a breakout.

#### Step 2 — ORB Breakout + Retest (the "sexy" version)

**ORB** = first 15-minute range (9:30–9:45 AM, 3 × 5-min candles).

Kay's exact rule:
1. Wait for **2 independent 5-min candles** to **fully close** above ORB high (for calls) or below ORB low (for puts). No part of either candle can touch the ORB line.
2. Wait for price to come back and **retest** the ORB level.
3. **Retest candle volume must be lower than the breakout candle volume.** High retest volume = trap or reversal → skip.
4. Enter on the **NEXT candle after the retest** — not on the retest candle itself. He repeats this 4+ times in his videos.
5. Stop loss goes on the **other side of the ORB** (not a fixed %).

The same breakout + retest logic works for:
- ORB high/low
- Pre-market high/low  
- NTZ top/bottom
- Any hourly level

#### Step 3 — Direction Filter

- **200 SMA on 5-min chart**: price above = calls only, price below = puts only, price chopping around it = no trade
- Both the ORB setup direction and the 200 SMA must agree before entering

#### Confluence Rule

> "You never want to take a trade by independence. One reason = gambling. You want confluence — multiple reasons aligning at the same spot."

Ideal confluence: ORB level + Fibonacci (0.236 or 0.382 retracement) + 8 EMA bounce, all at the same price. Our bot currently checks ORB + 200 SMA which is a solid starting point.

---

### Exit Strategy — "Negative Risk Management"

This is the piece that separates Kay's results from average traders. The goal is to trade the runner with **zero risk** after the first partial.

**With 2 contracts (our minimum):**

```
Entry: BUY 2 contracts at ATM strike

First level hit (+50% premium):
  → SELL 1 contract (lock in profit)
  → Move stop on contract #2 to BREAK-EVEN (entry price)
  → Worst case on runner: break-even. No loss possible.

Runner management:
  → Trail stop up based on STOCK STRUCTURE (not option price)
  → Every time stock makes a higher low (calls) or lower high (puts):
     update stop to that level
  → Exit runner when stock breaks below the most recent higher low

Second target (+100% or next hourly level):
  → SELL contract #2
  → Book the profit

EOD hard close (3:45 PM):
  → Close any remaining contracts with a real IB sell order
```

**"Levels are profit-taking areas, not entry signals."**  
Pre-market hourly levels become the zones where he scales out. He trims into strength, not weakness.

---

### Sizing — Bell Curve

- First trade of the day: **small**
- If market is clean and you're in rhythm: size up
- If red or unsure: stay small or stop entirely
- Never go max size on the first trade
- **Never trade 1 contract** — you can't execute the partial exit strategy with 1. Minimum 2.

### Walk Away Rule

> "If you make money in the first 30 minutes, you do not have to stay around. Cash those chips in. The money is not yours until you close the broker."

He made $11K in 26 minutes on two trades and called it a day. Consistency > trying to have one giant day. One huge day leads to overconfidence which leads to blowing the account.

---

## Implementation Status

### Phase 1 — Exit Management ✅ DONE (Jun 5, 2026)

| Change | Status |
|---|---|
| 2-contract minimum | ✅ `MAX_CONTRACTS = 2` |
| Partial exit at +50%: sell 1, runner to break-even | ✅ `PARTIAL_TARGET_MULT = 1.5` |
| Full close at +100% | ✅ `PROFIT_TARGET_MULT = 2.0` |
| Stop loss -50% (before first partial only) | ✅ `STOP_LOSS_MULT = 0.5` |
| Wire `closeAllScalpPositionsEod()` into scheduler | ✅ Runs at 3:45 PM ET |
| Fix null IB response → no longer marks $0 | ✅ Leaves FILLED if IB unavailable |

### Phase 2 — Runner Trailing Stop ✅ DONE (Jun 7, 2026)

| Change | Status |
|---|---|
| `fetchIntradayBars()` with 5-min and 2-min support | ✅ Yahoo Finance v8 API |
| Initialize `runner_stop_price` in metadata after first partial | ✅ At current stock price ±0.2% |
| Trail stop on higher lows (calls) / lower highs (puts) | ✅ `trailRunnerStop()` helper |
| Use 2-min bars for early session (9:30–10:00), 5-min after | ✅ Based on `filled_at` time |
| Close runner if stock price crosses the trailing stop | ✅ In `manageScalpPositions()` |
| Break-even premium stop as fallback if bars unavailable | ✅ |

### Phase 3 — ORB + NTZ + 200 SMA Entry Framework ✅ DONE (Jun 7, 2026)

| Change | Status |
|---|---|
| No entries before 9:45 AM (let ORB form) | ✅ `ORB_END_HOUR/MIN_ET` guard |
| Entry cutoff at 11:00 AM (was 11:30) | ✅ `LAST_ENTRY_MIN_ET = 0` |
| Scan every 5 min (was twice daily) | ✅ `*/5 9-10 * * 1-5` cron |
| NTZ filter — skip if inside box | ✅ `fetchNtz()` |
| ORB calculation from 9:30–9:45 bars | ✅ `fetchOrb()` |
| 2-candle breakout + low-volume retest detection | ✅ `detectOrbSetup()` |
| 200 SMA on 5-min bars for direction filter | ✅ `get5mSmaDirection()` |
| Direction agreement required (ORB + SMA must agree) | ✅ |
| `fetchIntradayBars()` now supports `includePrePost` | ✅ For pre-market H/L |

---

## What Still Differs From Kay's Framework

| Kay's Rule | Our Bot | Gap |
|---|---|---|
| Hourly levels as profit-taking zones | Fixed % targets (+50%, +100%) | Exits aren't at real price levels |
| Bell curve sizing (start small, size up) | Fixed 2 contracts always | No dynamic sizing |
| Fibonacci 0.236/0.382 as confluence | Not implemented | Lower priority |
| 8 EMA as confluence | Not implemented | Lower priority |
| After 11:00 → stop all new entries | ✅ 11:00 AM cutoff | Done |
| VWAP retest scan also stops at 11:00 AM | ✅ Updated | Done |
| "Two independent candles" fully outside ORB | ✅ Implemented | Done |
| Enter on NEXT candle after retest | Partially — 5-min scan frequency means we catch it on the following cycle | Close enough |

---

## Key Code Files

| File | Purpose |
|---|---|
| `auto-trader/src/lib/options-scalp.ts` | Core strategy: entry scan, position management, partial exits, runner stops |
| `auto-trader/src/lib/yahoo-finance.ts` | `fetchIntradayBars()`, `fetchDailyBars()` — data for NTZ, ORB, 200 SMA |
| `auto-trader/src/lib/options-chain.ts` | `findAtmStrike()` — IB option chain lookup |
| `auto-trader/src/scheduler.ts` | Cron wiring: scan every 5 min (9:45–11), manage every 15 min, EOD close 3:45 PM |

---

## How the Entry Decision Flow Works (current code)

```
runOptionScalpScan() — runs every 5 min, 9:45–11:00 AM ET

For each HIGH_VOL watchlist ticker:

  1. Time guard: skip if before 9:45 or after 11:00 AM
  2. IB connected? If not, skip
  3. Daily cap reached (2 trades)? If so, stop
  4. Already in open scalp for this ticker today? Skip

  5. Fetch quote + 5-min bars (5-day range for 200 SMA — ~390 bars)

  6. 200 SMA direction check:
     - Above SMA → calls only
     - Below SMA → puts only
     - Within 0.3% (chopping) → skip

  7. NTZ filter:
     - Fetch pre-market bars (includePrePost=true) → premarket H/L
     - Fetch daily bars → yesterday H/L
     - NTZ = max(preHigh, yesterdayHigh) to min(preLow, yesterdayLow)
     - Price inside NTZ → skip

  8. ORB calculation:
     - First 15-min bars (9:30–9:45) → ORB high + ORB low
     - Not enough bars → skip

  9. ORB retest detection (detectOrbSetup):
     - Find 2 consecutive bars with lows fully above ORB high (or highs below ORB low)
     - Check if next bar is retesting the ORB level
     - Check retest volume < breakout volume
     - No valid setup → skip

  10. Direction agreement: ORB direction must match 200 SMA direction

  11. Find ATM strike → check bid, spread, premium cap

  12. Execute trade (2 contracts)
```

---

## Why Today's -$2,559 Loss Happened (Jun 5, 2026 post-mortem)

Root cause chain that triggered this entire refactor:
1. Bot held all 6 positions to EOD (no partial exits during the move)
2. Auto-trader restarted multiple times → IB connection was unstable at 3:45 PM
3. `closeAllScalpPositionsEod()` was never wired into the scheduler (dead code)
4. `manageScalpPositions` called `getOptionGreeksForContract` → IB disconnected → null → `null?.mid ?? 0` = 0
5. Code assumed all options worthless → marked DB CLOSED at $0 without placing IB sell orders
6. IB still held all 7 positions; 3 were ITM but no sell orders ever fired
7. Options expired, value lost

If partial exits had fired during the day, most positions would have been closed or at break-even before the EOD failure was ever reached.
