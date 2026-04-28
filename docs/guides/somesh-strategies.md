# Somesh's Trading Strategies — Reference Guide

> Source: video transcripts from Somesh (influencer)
> Implemented: 2026-04-27

All four strategies are now live in the auto-trader. This guide is the single place to understand the full system — what each rule is, why it works, and how it's implemented.

---

## The Full Confluence Checklist

When ALL of these align, Somesh considers it a maximum-conviction trade:

```
✅ SPX at a $50 key level           → structural support/resistance
✅ QQQ at a whole-dollar level       → second instrument confirming the zone
✅ Price outside the 15-min ORB      → directional trend has started, not chop
✅ Price near VWAP (after 10 AM)     → institutional anchor point
✅ Break → 2 independent candles → retest pattern on SPX  → clean entry signal
```

All five don't need to be present for every trade. But the more that align, the higher the probability of a clean directional move.

---

## Strategy 1: SPX $50 Key-Level Breakout-Retest

**The rule:** $50 levels on SPX (5500, 5550, 5600…) are the most-watched structural levels by institutions and algorithms. When price breaks one cleanly and retests it, enter SPY in the direction of the break.

**4-step entry pattern:**
```
1. A 5-min SPX candle CLOSES beyond the level (the "break")
2. Next 5-min candle: high/low does NOT touch the level (independent)
3. Next 5-min candle: high/low does NOT touch the level (independent)
4. Price returns and TOUCHES the level (retest) → ENTER SPY
```

**Trade direction:**
- Break ABOVE level → **BUY SPY**
- Break BELOW level → **SELL SPY**

**Exit:**
- Stop: ~$1.00 beyond the level in SPY terms
- Target: next $50 SPX level in the direction of the break

**Why it works:** Institutional algos have limit orders stacked around round SPX numbers. A clean break means those orders have been consumed. The retest is the last chance for late buyers/sellers to participate before the next leg.

**Implemented in:** `auto-trader/src/lib/spx-level-scanner.ts`
**Docs:** [SPX Level Scanner](../features/spx-level-scanner.md)

---

## Strategy 2: ORB — Opening Range Breakout as a Chop Filter

**The rule:** The first 15 minutes (3 × 5-min candles from 9:30–9:45 AM ET) define the "opening range." If price is stuck inside that range, the market is indecisive — **don't trade it.** Wait for a directional breakout.

**ORB states:**
```
ABOVE the ORB high  → uptrend started → BUY setups OK
BELOW the ORB low   → downtrend started → SELL setups OK
INSIDE the ORB      → choppy → SKIP all day trades
```

**Somesh's examples:**
- QQQ: sat inside ORB → choppy all morning → clean trend once it broke
- NVDA: inside ORB for hours → broke → exploded up
- MERA: broke above ORB → trended cleanly

**The "break and retest" extension (not yet automated):**
The ORB high/low itself can act like a key level. A break + retest of the ORB boundary is a valid entry — same 4-step pattern as Strategy 1, but using the ORB line instead of a $50 SPX level.

**Implemented in:** `auto-trader/src/lib/orb.ts`
Applied as a gate in `executeScannerTrade` (all day trades) and in `checkSpxLevelSetups` (SPX level scanner).
**Docs:** [ORB Chop Filter](../features/orb-chop-filter.md)

---

## Strategy 3: VWAP — Institutional Anchor Price

**The rule:** VWAP (Volume Weighted Average Price) is where institutional desks are benchmarked. They **buy at or near VWAP** (can't justify overpaying) and **sell at or near VWAP** (won't undercut their exit). This makes VWAP a reliable dynamic support/resistance.

**VWAP formula:**
```
typical_price = (high + low + close) / 3
VWAP = Σ(typical_price × volume) / Σ(volume)    [anchored to 9:30 AM session open]
```

**Trade application:**
- Price approaches VWAP → bounce/rejection → trade in direction of rejection
- Failed bounce → retest → entry on retest
- Sold at VWAP after a directional move = a common profit-taking level

**Critical rule:** ⚠️ **Only reliable after 10:00 AM ET.** Before that, insufficient session volume for institutional anchoring.

**How it's used in the auto-trader:**
- Confidence modifier: +0.3 when price is within 0.5% of VWAP and direction is aligned
- Not a hard gate — non-blocking if data is unavailable or before 10 AM
- Logs the VWAP distance and alignment for every day trade

**Implemented in:** `auto-trader/src/lib/vwap.ts`
Applied in `executeScannerTrade` after ORB gate.
**Docs:** [VWAP Alignment](../features/vwap-alignment.md)

---

## Strategy 4: Confluence — Multiple Reasons to Trade

**The rule:** "Confluence simply means when you have more than one reason to jump into a trade." Each independent signal increases probability. Somesh's backtested estimate: a single signal has ~58% win rate; two aligned signals → ~92%.

**The primary confluence Somesh uses:**
- SPX at a $50 structural level **AND** QQQ at a whole-dollar level ($640, $650, $660…) simultaneously
- Both pointing the same direction → enter puts/calls on SPX (or trade SPY)

**QQQ whole-number levels:** $10 increments ($450, $460, $470…) act as the equivalent of SPX $50 levels for the Nasdaq.

**How it's used in the auto-trader:**
- After the SPX level scanner detects a retest, it checks if QQQ is also within $1.00 of a whole-dollar level and aligned directionally
- If confluence is detected: confidence bumped from 9 → 9.5, tagged `qqq_confluence` in `auto_trade_events`
- If no confluence: trade still executes at confidence 9 (confluence is additive, never a gate)

**Implemented in:** `checkQqqConfluence()` inside `auto-trader/src/lib/spx-level-scanner.ts`
Called during `checkSpxLevelSetups()` when a retest triggers.

---

## How the Strategies Stack in a Single Trade

Here's what happens when the auto-trader processes a day trade from the SPX level scanner:

```
SPX retest triggers (Strategy 1)
    │
    ├─ Is SPX inside its ORB?                 (Strategy 2)
    │    └─ Yes → defer, re-check next cycle
    │    └─ No  → continue
    │
    ├─ Is QQQ near a whole-dollar level?      (Strategy 4)
    │    └─ Yes → confidence 9 → 9.5, tag qqq_confluence
    │    └─ No  → confidence stays 9
    │
    └─ executeScannerTrade(SPY, confidence=9/9.5)
          │
          ├─ ORB gate (ticker = SPY)           (Strategy 2 again, for SPY itself)
          ├─ VWAP modifier (after 10 AM)       (Strategy 3) → ±0.3 confidence
          ├─ Candle pattern modifier           → ±0.5/1.0 confidence
          └─ Pre-trade checks → IB order
```

---

---

## Strategy 5: Wyckoff Volume Divergence — "Four More Phase"

**Source:** Somesh video, 2026-04-28

**The rule:** Every major market move has four phases: Accumulation (chop) → Public Phase (breakout on HIGH volume) → Four More Phase (new high on LOWER volume than the breakout) → Distribution (reversal). The tell is the volume signature: if a new high is made on meaningfully less volume than the prior peak, retail is chasing (FOMO) while smart money is already out. That's the Four More Phase — and distribution is coming next.

**The signal:**
```
1. Accumulation: price chops in a tight range
2. Public Phase: breakout candle prints with HIGH volume (this becomes the reference)
3. Four More Phase: price pulls back, then makes a NEW HIGH — but volume is weaker than the breakout
4. Distribution: structure fails, reversal begins
```

**Entry (short side):** Wait for the structure to fail after the Four More high → retest → SHORT.

**Why it works:** Institutional volume is the fuel for moves. If a new high has less fuel than the prior surge, there's no new conviction behind it — just retail momentum-chasers. The prior high becomes distribution overhead. Works on all timeframes (2m, 5m, 15m, daily).

**Connection to Wyckoff:** This is textbook Wyckoff Distribution Theory (1930s), also known as "Upthrust After Distribution" (UTAD). Well-documented in VSA (Volume Spread Analysis) and Stan Weinberg's Stage Analysis. Signal quality: ~65-70% with full sequence confirmed; ~50% on volume divergence alone.

**How it's used in the auto-trader (as of 2026-04-28):**

The system uses this concept as a **swing trade entry gate** — not a short signal (yet):

- `volumeVsPriorPeak` = today's volume ÷ highest-volume session in last 20 daily bars
- Computed in `trade-scanner` edge function via `buildIdea()`, using existing `_ohlcvBars`
- If `volumeVsPriorPeak < 0.65` AND signal is BUY: **skip the swing trade** (`skipped:swing_volume_divergence`)
- If `volumeVsPriorPeak < 0.6`: adds `volume-divergence` tag to `TradeIdea`

**Real-world case:** AAON (2026-04-28) had `volumeVs10dAvg = 0.06x` — the stock was in a Four More Phase. The system entered long anyway (Groq fallback generated a bullish narrative). The position lost -$1,807 when the stop was blown through by $1.04 on thin tape. Both the volume-vs-avg gate AND this prior-peak gate would have blocked the trade.

**Implemented in:** `supabase/functions/trade-scanner/index.ts` (field computation) + `auto-trader/src/scheduler.ts` (execution gate)

**Full short-side automation (future):** Build a `four-phase-scanner.ts` state machine after validating the divergence alert's hit rate on 30+ days of real scanner output. See `docs/cursor/2026-04-28-90-minute-rule.md` backlog pattern for how to spec this.

---

## What's Not Automated (Yet)

| Concept | Status | Notes |
|---------|--------|-------|
| ORB break+retest as standalone signal | Not built | Same state machine as SPX scanner but using ORB high/low as the level |
| VWAP as standalone entry signal | Not built | Build once VWAP modifier data shows clear win-rate lift |
| Multi-timeframe VWAP (weekly/monthly) | Not in scope | Session VWAP is sufficient for day trades |
| QQQ-specific level scanner (NDX levels) | Not built | QQQ has its own $10 key levels worth scanning separately |
| Wyckoff full state machine (short side) | Backlog | Need 30+ days of divergence alert data first; see Strategy 5 above |
| Backtesting / win-rate analysis | Manual | Use `auto_trade_events` with `source = spx_level_scanner` to query outcomes |

---

## Monitoring Queries

Check SPX level scanner trades:
```sql
select ticker, event_type, message, created_at, source, spx_level, direction, confluence
from auto_trade_events
where source = 'spx_level_scanner'
order by created_at desc;
```

Check ORB skip rate:
```sql
select count(*), skip_reason
from auto_trade_events
where skip_reason = 'inside_orb'
  and created_at > now() - interval '14 days'
group by skip_reason;
```

Check VWAP confluence trades:
```sql
select message, created_at
from auto_trade_events
where message ilike '%vwap%'
  and created_at > now() - interval '14 days'
order by created_at desc;
```
