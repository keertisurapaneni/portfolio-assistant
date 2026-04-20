# Options Wheel Engine — System Design Plan

**Date:** 2026-04-20
**Session type:** Brainstorming (First Principles → SCAMPER → Stress Test → Decision Tree)
**Goal:** Build an options signal system that beats the baseline 60% annual return achieved manually

---

## Executive Summary

The household baseline is already proven: selling puts on quality stocks generates ~5% per month (~60% annually). The Medium article and the user's husband both independently arrive at the same number doing the same strategy manually on 1–3 stocks at a time.

**The system's edge is not a smarter strategy — it's scale and consistency:**
- Run the same proven strategy on 10–15 stocks simultaneously
- Never miss an opportunity due to human inattention
- Auto-close at 50% profit and immediately redeploy capital
- Apply systematic signal filters the human gut can't replicate
- Beat the husband benchmark: >60% annual return, verified via side-by-side paper tracking

**Target return:** 70–80% annually
**Capital base:** $100K
**Method:** Automated Wheel Strategy (sell puts → get assigned → sell covered calls → repeat)
**Validation gate:** Paper trade until system beats 60% benchmark for 2 consecutive months → then go live

---

## The Core Edge: Why Selling Options Works

Three fundamental truths that make this profitable:

1. **Fear is overpriced** — Options buyers consistently overpay by 20–30% vs. actual realized volatility. The seller collects that fear premium.
2. **Time destroys option value** — Every day an option exists, it loses value regardless of stock movement. The seller owns time; the buyer fights it.
3. **Most stocks don't move as much as people expect** — ~70% of options expire worthless. The seller wins when nothing dramatic happens — which is most of the time.

**The formula:**
> Sell options on quality stocks you'd want to own, when fear is highest, when the stock is unlikely to make a big move, at price levels where you'd be happy owning shares.

---

## The Husband Decoder

What the husband does manually (decoded from conversation):

| His gut feeling | What it actually is |
|---|---|
| "I know the company" | Fundamental quality filter |
| "Oversold at this level" | RSI < 35 + price at support |
| "Charts look right" | Technical confirmation (not in freefall) |
| "This is on my buy list at this price" | Only sells puts he'd be happy getting assigned |

He's firing 4 converging signals simultaneously — he just doesn't know it. The system replicates all 4 systematically, across 10–15 stocks, without sleep or emotional bias.

---

## Signal Library (46 Ideas Generated)

### Core Entry Signals
1. **Quality Filter** — Only scan stocks on the pre-approved buy list (stocks you'd genuinely want to own)
2. **Oversold + Support Level** — RSI < 35 AND price near a known support level
3. **Technical Confirmation** — Not in freefall; 20-day MA stabilizing or recovering
4. **Fundamental Backbone** — Profitable company, strong balance sheet, long track record
5. **IV Rank > 60** — Current implied volatility in the top 40% of its 52-week range (premium is fat)
6. **RSI Oversold + Bounce Confirmation** — RSI below 35 AND turning back upward (floor confirmed, not catching a knife)
7. **Earnings Blackout** — Never sell puts within 14 days of earnings
8. **20–25 Delta Strike** — Target the strike with ~20–25% probability of expiring in-the-money (75–80% win rate mathematically)
9. **Premium Yield Threshold** — Only enter if premium ≥ 1% of stock price for a 30-day expiry
10. **Sector Stability Check** — Confirm the sector ETF (XLK, XLF, etc.) is stable or recovering before entering

### Advanced Signal Ideas
11. **Wheel on Steroids** — Run 8–12 stocks simultaneously at different stages of the wheel; system tracks each position's stage
12. **Post-Earnings IV Crush Play** — Right after earnings drop on a quality stock, IV is still elevated but earnings risk is gone — best put-selling timing
13. **Put/Call Skew Signal** — When puts are dramatically more expensive than calls (fear mode), premium is maximum
14. **IV Spike Filter (News Alert)** — If IV jumped >20 points in the last 5 days (sudden spike vs. gradual), flag for human review — don't auto-execute
15. **Net Price Display** — Show (strike - premium) = effective buy price on every trade card. Forces the question: "Would I own this stock at this price?"
16. **Market Regime → Strike Distance Rule** — Bull market: sell 10–15% below current price. Bear: ladder strikes. Sideways: sell at established support level.

### Risk & Portfolio Signals
17. **Max 5 Positions Rule** — Never have more than 5 open puts simultaneously (raise to 10–15 after validation)
18. **Sector Concentration Cap** — Max 2 puts per sector at any time
19. **SPY Drop 10% Stress Test** — Before entering, calculate combined damage if SPY drops 10% today. Block if total risk exceeds threshold.
20. **50% Profit Auto-Close** — When a sold put reaches 50% of max profit, close it automatically. Frees capital faster.
21. **Bear Market Pause** — If SPY < SMA200, stop all new put-sell orders. Resume when SPY reclaims SMA200.
22. **VIX-Based Position Sizing** — VIX > 25: smaller positions, wider strikes. VIX 15–20: normal size. VIX < 15: can be more aggressive.
23. **Trend Confirmation Gate** — Stock must be in uptrend or sideways range. Block if stock is in a fresh multi-week downtrend.
24. **Capital Sufficiency Check** — Before every put: verify `free_cash ≥ strike_price × 100 × contracts`. Hard block if insufficient.
25. **Cash Reserve Display** — Every trade card shows: "This trade requires $X in reserve if assigned. You have $Y available (Z% utilization)."

### Portfolio-Level Ideas
26. **Strike Laddering** — In volatile/bear markets, sell puts at multiple strikes on same stock (e.g., $45, $40, $35) — progressively better prices with bigger premiums if stock falls
27. **Annualized Yield Metric** — Track and optimize annualized return on capital deployed, not just raw premium collected
28. **Premium Reinvestment Engine** — Never sit in cash. When a position closes, system immediately scans for the next best opportunity on the watchlist.
29. **Covered Call Auto-Suggestion** — When assigned shares (put exercised), system immediately generates the best covered call suggestion
30. **Covered Call Pause on Assignment** — After shares are called away, system pauses wheel on that stock and shows net P&L of full cycle before restarting

### Learning & Benchmarking
31. **Win Rate by Signal Combo Tracker** — After 50 trades, identify which combinations of signals produce the highest win rate
32. **"Better Than Husband" Scorecard** — Side-by-side monthly report: system paper trades vs. husband's manual trades
33. **Assignment Simulator** — Before going live, simulate: "What if every put this month got assigned?" Shows total capital required and recovery timeline
34. **Husband Decoder** — Log 20 of husband's trades; system reverse-engineers his pattern to build his best instincts into the algorithm

### Market Condition Adaptations
35. **Bull Market Strategy** — Lower premiums; be more selective; focus on temporary pullbacks in strong stocks; strikes 10–15% below current price
36. **Bear Market Laddering** — Juiciest premiums but highest assignment risk; use laddered strikes; strict position sizing
37. **Sideways Market Strategy** — Target clear support levels where stock has repeatedly bounced; high probability setups

### System Infrastructure
38. **Eliminate Naked Calls** — Hard block on selling calls unless shares are owned (covered calls only). Never naked call.
39. **Liquidity Filter** — Options must have open interest > 500 and volume > 100. Skip illiquid contracts.
40. **Minimum Stock Price** — No options on stocks under $20 (prefer $50+). Premium isn't worth the assignment risk on cheap stocks.
41. **IB Options Chain Integration** — Pull live IV rank, delta, bid/ask, open interest directly from IB API (`reqSecDefOptParams` + `reqMktData`), not Finnhub
42. **Options Tab UI** — Dedicated tab in the app with: daily opportunities, open positions, assignment tracker, monthly scorecard
43. **Emergency Pause Button** — One-click "Pause Options Engine" that stops all new entries but continues managing existing positions
44. **Intraday Monitoring** — Check options P&L every 30 minutes during market hours for 50% profit close signals
45. **Expiry Countdown + Roll Alert** — When position hits 21 days to expiry, alert: "Roll or close decision needed"
46. **Assignment Tracker** — When put is exercised, automatically create covered call suggestion and flag in UI

---

## Stress Test: 10 Ways This Fails

| Failure Mode | Safeguard |
|---|---|
| Watchlist doesn't exist on Day 1 | Seed immediately with husband's holdings + Steady Compounders list (min 20 tickers) |
| Options chain data not available via Finnhub | Pull directly from IB API — it supports options chains natively |
| Assignment with no capital to cover | Hard block: verify free cash ≥ strike × 100 × contracts before every trade |
| Multiple assignments in a market crash | Max 3 open puts when VIX > 25; never deploy >60% of capital into put obligations |
| Earnings surprise despite blackout rule | Check multiple calendar sources; add CEO/analyst day flags; allow manual override |
| 50% profit close never triggers (daily check too slow) | Monitor every 30 minutes during market hours |
| High IV because company is in trouble | News spike filter: if IV jumped >20pts in 5 days, require human review |
| Paper returns don't translate to live (slippage) | Paper trades simulate at mid-price minus $0.05; build in 5–10% slippage assumption |
| Covered call called away, re-enter at higher price | Show full cycle P&L after assignment; pause before automatically restarting wheel |
| No human override during crisis | "Pause Options Engine" button in UI — stops all new entries immediately |

---

## Decision Tree: The System Logic

```
EVERY MORNING (9:00 AM ET):
│
├─ Is SPY above SMA200?
│   └─ NO → Log "Bear market gate active" → STOP all new puts
│   └─ YES → Continue
│
├─ Is VIX > 30?
│   └─ YES → Max 3 positions allowed
│   └─ 20-30 → Max 5 positions allowed
│   └─ < 20 → Max 10 positions allowed
│
├─ How many open puts do we have?
│   └─ AT MAX → STOP, no new trades today
│   └─ BELOW MAX → Continue scanning watchlist
│
FOR EACH STOCK ON WATCHLIST:
│
├─ Is earnings within 14 days?
│   └─ YES → Skip
│
├─ Did IV spike >20pts in last 5 days? (news event)
│   └─ YES → Flag for human review, skip auto-execute
│
├─ Is IV Rank > 60?
│   └─ NO → Skip (premium not rich enough)
│
├─ Is RSI < 35 AND turning upward?
│   └─ NO → Skip (not oversold or still falling)
│
├─ Is stock above $20? Options liquid enough?
│   └─ NO → Skip
│
├─ Is free cash ≥ strike price × 100?
│   └─ NO → Skip (can't cover assignment)
│
├─ Would adding this position exceed sector cap (2)?
│   └─ YES → Skip
│
└─ ALL CHECKS PASS → Generate trade ticket:
    - Strike: 20–25 delta put (adjust for market regime)
    - Expiry: 30–45 days out
    - Premium: must be ≥ 1% of stock price
    - Net price: strike - premium (effective cost if assigned)
    - Probability of profit: display
    - Capital required: strike × 100 (display)
    - Annual yield: calculate and display
    → Paper trade automatically
    → Show in Options tab
    → Send alert

EVERY 30 MINUTES (market hours):
│
└─ For each open options position:
    ├─ Value ≤ 50% of original premium? → Auto-close, redeploy capital
    ├─ Expiry ≤ 21 days? → Alert "Roll or close decision needed"
    └─ Put assigned? → Generate covered call suggestion immediately
```

---

## Trade Ticket UI Spec

```
┌────────────────────────────────────────────┐
│  AAPL — Sell $170 Put  ·  Jan 31 (30d)    │
│  ─────────────────────────────────────    │
│  Premium collected:     $2.30  ($230)     │
│  Net price if assigned: $167.70           │
│  Probability of profit: 79%               │
│  Annual yield on capital: 33%             │
│                                           │
│  Capital required:  $17,000               │
│  % of free cash:    39%   [within limit]  │
│                                           │
│  Market regime:   Bull → strike 12% below │
│  IV Rank: 74  RSI: 28↑  Earnings: 47 days │
│                                           │
│  ✅ All 8 checks passed                   │
│  [Paper Trade]        [Skip]              │
└────────────────────────────────────────────┘
```

---

## Options Tab UI Spec

```
Options Wheel Engine                [Pause Engine] [Scan Now]
─────────────────────────────────────────────────────────────

TODAY'S OPPORTUNITIES  (3 found)

  AAPL  $170P  Jan31  · Premium $2.30  · 79% prob  · Yield 33%
  Net price: $167.70  · Capital: $17,000             [Paper]

  MSFT  $380P  Jan31  · Premium $3.10  · 77% prob  · Yield 29%
  Net price: $376.90  · Capital: $38,000             [Paper]

  KO    $60P   Jan31  · Premium $1.00  · 81% prob  · Yield 20%
  Net price: $59.00   · Capital: $6,000              [Paper]

OPEN POSITIONS  (2)

  NVDA  $480P  · 12 days left  · +68% profit  · [Close Now]
  TSLA  $200P  · 24 days left  · +41% profit  · [Hold]

ASSIGNED — ACTION NEEDED
  AAPL  100 shares @ $167.70  · [Sell Covered Call]

MONTHLY SCORECARD
  Premium collected:  $2,840
  Win rate:          7 / 8  (87%)
  vs. Husband:       [Connect his trades]
  Annualized rate:   ~68%
```

---

## System Architecture: Integration with Existing Auto-Trader

The options engine is ~60% already built — it reuses existing infrastructure:

| Component | Status |
|---|---|
| Interactive Brokers connection | ✅ Already live — IB supports options orders natively |
| Paper trade database + P&L tracking | ✅ Already exists — add `mode: OPTIONS_PUT / OPTIONS_CALL` |
| Bear market gate (SPY < SMA200) | ✅ Already built for Steady Compounders |
| Earnings calendar | ✅ Already used in trade scanner |
| Sector concentration tracking | ✅ Already exists for long positions |
| IB connectivity watchdog | ✅ Already built |
| Smart Trading dashboard + event log | ✅ Already exists — add options events |
| **Options chain data (IV rank, delta, greeks)** | ❌ **New — pull from IB API** |
| **Strike/expiry selector** | ❌ **New — calculate 20-25 delta strike** |
| **Options-specific order types** | ❌ **New — sell-to-open limit orders** |
| **Expiry countdown + roll alerts** | ❌ **New** |
| **Options Tab UI** | ❌ **New** |

New build is mostly the options scanner, chain data feed, and the dedicated UI tab.

---

## Build Sequence

**Week 1–2: Data foundation**
- Confirm IB API returns options chains (strikes, expiry, IV, delta, bid/ask)
- Build IV rank calculation (current IV vs. 52-week range)
- Build the watchlist management UI (add/remove tickers)

**Week 3–4: Signal engine**
- Build the morning scanner with all 8 entry checks
- Generate trade tickets with net price, capital required, annual yield
- Paper trade execution (new `OPTIONS_PUT` mode in existing paper trades table)

**Week 5–6: Position management**
- Intraday 30-minute monitoring loop
- 50% profit auto-close
- Assignment detection → covered call suggestion
- Expiry countdown + roll alerts

**Week 7–8: UI + validation**
- Options Tab with opportunities, open positions, assignment tracker
- Monthly scorecard vs. husband benchmark
- Paper trade for 2 months; validate against 60% target

**Go-live gate:** System shows >60% annualized return in paper trading for 2 consecutive months → enable real IB execution

---

## Key Decisions & Tradeoffs

| Decision | Chosen Approach | Rationale |
|---|---|---|
| Options chain data source | IB API (not Finnhub) | Finnhub doesn't reliably provide options Greeks; IB is already connected |
| Default expiry | 30–45 days (theta sweet spot) | Fastest time decay, manageable time horizon |
| Default delta target | 20–25 delta | ~75–80% probability of profit, meaningful premium |
| Profit target | 50% of max premium | Captures most gain with half the time at risk |
| Position limit | 5–10 concurrent puts | Enough diversification without overextending capital |
| Strategy scope | Sell puts + covered calls only | No naked calls, no spreads in v1 — keep it simple and safe |

---

## Success Metrics

- Paper trade win rate > 70%
- Monthly premium income ≥ 3.5–4% of capital deployed
- Annualized return > 60% (beats husband benchmark)
- Zero assignments on stocks not on the approved buy list
- Zero positions opened during bear market gate

---

*Session: Brainstorming — First Principles + SCAMPER + Reverse Brainstorming + Decision Tree*
*Phases completed: 1 (First Principles), 2 (SCAMPER), 3 (Stress Test), 4 (Action Plan)*
*Total ideas generated: 46*
*Key insight: The baseline strategy already works (60% annually proven by husband + Medium article). The system's edge is scale (10–15 simultaneous positions) + discipline (never miss a signal, always close at 50% profit, never sell in bear markets).*
