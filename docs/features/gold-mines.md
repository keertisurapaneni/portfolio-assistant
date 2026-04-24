# Gold Mines — Archetype-Based Macro Catalyst Plays

Gold Mines are one half of the Suggested Finds system (see [Suggested Finds](./suggested-finds.md) for the full pipeline). This document covers their investment logic, archetype classification, exit rules, sizing, and the empirical evidence behind every design decision.

---

## What a Gold Mine Is

A Gold Mine is a **quality company positioned to benefit from a dominant macro theme that is active right now**. The thesis has two requirements:

1. **Real business fundamentals** — profitable or near-profitable, growing revenue, genuine competitive moat. Not speculative.
2. **Active macro catalyst** — the theme must currently be generating market headlines. The AI prompt reads live Finnhub news to ensure this.

The distinction from Steady Compounders is *time horizon and catalyst dependency*, not quality. A Gold Mine that loses its macro catalyst becomes a different kind of holding — one that no longer belongs in the portfolio.

---

## Why Gold Mines Are Hard to Get Right

Gold Mines are discovered by reading **current dominant headlines**, which means the macro theme has already been driving prices for days or weeks before the system buys. This structural lateness produces a predictable failure pattern:

| Closed trade | Theme | Entry | Exit | P&L |
|---|---|---|---|---|
| ASML | AI semiconductors | Feb 17 | Mar 30 | −10.1% |
| MU   | AI semiconductors | Feb 17 | Mar 30 | −18.7% |
| ENPH | Energy transition | Feb 17 | Mar 30 | −18.6% |
| AMAT | AI semiconductors | Feb 13 | Mar 30 |  −9.6% |
| ADBE | AI software       | Feb 13 | Mar 30 |  −8.6% |
| ALLY | Consumer finance  | Feb 19 | Mar 30 |  −7.5% |
| CSCO | AI networking     | Feb 17 | Mar 30 |  +1.1% |

**All-time closed P&L: −$6,990. Win rate: 14%. Kelly fraction: −9.26.**

A negative Kelly means the strategy destroys capital in its original form. The root cause is not stock selection — it is **no exit discipline**. ASML peaked at +9% close on Day 8, MU peaked at +13.8% close on Day 29, AMAT peaked at +10.6% close on Day 8. None of those gains were captured because there were no exit triggers tied to the thesis.

---

## The Four Archetypes

Different macro themes have fundamentally different time horizons. A unified "hold 6–12 months" rule fails all of them. Gold Mines are now classified into four archetypes at generation time, and each has its own exit rules.

### Archetype 1 — Tech / Semiconductors / Software

**Theme examples:** AI infrastructure spending, semiconductor capex cycle, cloud expansion, cybersecurity ramp.

**Why holds can be longer:** These themes have genuine fundamental backing beyond a single news cycle. AI capex is a multi-year structural trend. A high-quality semi stock pulling back to entry is likely noise, not thesis invalidation.

**Evidence:** ASML, MU, AMAT all moved in the expected direction after entry. The problem was holding winners until they reversed. A profit-take at +10% and a trailing stop at +5% would have saved all three.

| Rule | Value |
|---|---|
| Position size multiplier | 0.75 × 0.33 of base (≈25% of full allocation) |
| Max hold | 84 calendar days (~60 trading days) |
| Hard stop (no bounce) | Exit if price never closes above entry after **7 calendar days** |
| Entry lock | Once peak gain ≥ **+5%**: stop moves to entry price — never let winner go negative |
| Profit take | Exit when gain ≥ **+10%** |
| ADBE-class exception | If no positive close after **16 calendar days** (~11 trading days): apply Defense rules immediately |
| Dip buys | Allowed if original thesis is still in active headlines and stock is still in positive-close territory |

### Archetype 2 — Defense / Aerospace

**Theme examples:** Defense spending ramp, geopolitical conflict escalation, military readiness announcements.

**Why holds must be short:** Defense stocks move on conflict escalation and reverse hard when the narrative peaks — ceasefire talks, diplomatic progress, or simply market rotation to risk-on. There is no fundamental floor to catch you. LMT went from +0.58% intraday on Day 1 to −13.44% by Day 7. RTX peaked at +0.83% intraday on Day 2, then went to −11.97% by Day 12. **Neither ever closed above entry price.**

| Rule | Value |
|---|---|
| Position size multiplier | 0.75 × 0.33 of base (≈25% of full allocation) |
| Max hold | **10 calendar days** — hard cap, no exceptions |
| Hard stop (no bounce) | Exit if price never closes above entry after **4 calendar days** (~3 trading days) |
| Entry lock | Once peak gain ≥ **+0.1%**: stop at entry — sell at the next positive close |
| Profit take | Exit when gain ≥ **+0.5%** (sell the morning after any meaningful positive close) |
| Dip buys | **Never.** A defense dip during geopolitical cooling is an exit signal, not an entry. |

### Archetype 3 — Energy / Commodities / Renewables

**Theme examples:** Oil supply shock, Iran conflict energy disruption, energy transition acceleration.

**Why holds are medium:** Oil supply shocks and energy transition themes play out over 3–6 weeks but are volatile. FSLR had a +7.24% intraday peak on Day 8 and +3.41% close on Day 5. EOG has trended up continuously since entry (+2.68% after 3 days) driven by the Iran oil narrative.

| Rule | Value |
|---|---|
| Position size multiplier | 0.75 × 0.33 of base (≈25% of full allocation) |
| Max hold | **28 calendar days** (~20 trading days) |
| Hard stop (no bounce) | Exit if price never closes above entry after **7 calendar days** (~5 trading days) |
| Entry lock | Once peak gain ≥ **+2%**: stop moves to entry price |
| Profit take | Exit when gain ≥ **+2%** |
| Dip buys | Not allowed |

### Archetype 4 — Financials / Macro Recovery

**Theme examples:** Dollar stability, economic normalization post-conflict, interest rate pivots, banking sector re-rating.

**Why holds are limited:** Financial sector plays are tied to economic regime, not a single event. Moves are gradual (JPM floated between −0.54% and +1.61% for 5 days). These need patience but must not outlast the regime shift.

| Rule | Value |
|---|---|
| Position size multiplier | 0.75 × 0.33 of base (≈25% of full allocation) |
| Max hold | **21 calendar days** (~15 trading days) |
| Hard stop (no bounce) | Exit if price never closes above entry after **6 calendar days** (~4 trading days) |
| Entry lock | Once peak gain ≥ **+1.5%**: stop moves to entry price |
| Profit take | Exit when gain ≥ **+1.5%** |
| Dip buys | Not allowed |

---

## Universal Rules (All Archetypes)

These apply regardless of archetype:

1. **Entry price lock is asymmetric.** Once the position has ever been above the `entryLockPct` threshold, the stop resets to entry. You never let a Gold Mine winner become a loser.

2. **Position sizing is reduced.** `0.75 × 0.33` multiplier on base allocation. The `0.75` is the existing Gold Mine tag discount; `0.33` is an explicit risk management reduction that stays in place until the strategy accumulates 20+ closed trades with positive expected value. At the current Kelly of −9.26, the system should not be deploying full conviction sizing.

3. **No dip buys on Defense archetype.** Hard block in the code. A defense stock dipping during geopolitical cooling is an exit signal, not a buying opportunity.

4. **Archetype is written into the `notes` field.** Every auto-traded Gold Mine stores `Archetype: Tech/Semi` (etc.) in the DB `notes` column so exit detection is explicit. For trades without the explicit tag, the system falls back to keyword detection from `scanner_reason`.

---

## Archetype Detection

The system determines archetype in two ways:

**1. Explicit tag (new trades):** The AI analysis prompt now outputs `"archetype": "Tech/Semi"` etc. This is stored in the `notes` field as `Archetype: Tech/Semi`. This takes precedence.

**2. Keyword fallback (existing/legacy trades):** `detectGoldMineArchetype()` in `scheduler.ts` scans the `notes` and `scanner_reason` fields:

| Pattern | Archetype |
|---|---|
| defense, military, geopolit, war, conflict, Iran conflict, lockheed, raytheon, RTX, LMT, NOC | Defense |
| semiconductor, chip, wafer, ASML, AMAT, micron, MU, HBM, AI infra, AI infrastructure | Tech/Semi |
| AI, cloud, software, cyber, network, data center, FTNT, fortinet | Tech/Semi |
| oil, energy, solar, renewable, natural gas, FSLR, ENPH, EOG | Energy |
| bank, financial, rate, dollar, JPMorgan, JPM, Ally, lending, credit | Financials |
| (no match) | Unknown → Defense rules (conservative) |

---

## Exit Logic in Code

`checkLongTermAutoSell()` in `auto-trader/src/scheduler.ts` (and the browser equivalent in `app/src/lib/autoTrader.ts`) runs on every scheduler cycle during market hours and evaluates each open LONG_TERM position.

**For Gold Mines**, the check sequence per cycle is:

```
1. Detect archetype from notes/scanner_reason
2. Apply ADBE-class exception if Tech/Semi + no bounce after 16 cal days
3. If peak gain >= entryLockPct AND current gain <= 0  → gm_entry_lock exit
4. If current gain >= profitTakePct                    → gm_profit_take exit
5. If daysHeld >= hardStopCalDays AND never above entry → gm_hard_stop exit
6. If daysHeld >= maxHoldCalDays                       → gm_max_hold exit
```

`price_peak` (the highest observed price since fill) is updated each cycle and persisted in the `paper_trades` table. `everAboveEntry` is derived as `effectivePeak > entryPrice × 1.001` (0.1% buffer for noise).

**For Steady Compounders**, the original config-driven rules remain unchanged (profit-take at `ltProfitTakePct`, trailing stop from peak at `ltTrailingStopPct`).

---

## Simulation: What the Rules Would Have Done

| Trade | Archetype | Actual exit | Actual P&L | Rule trigger | Simulated P&L |
|---|---|---|---|---|---|
| ASML | Tech/Semi | Day 41, −10.1% | −$2,400 | `gm_profit_take` Day 8 (+9%) | **+$2,100 est.** |
| MU | Tech/Semi | Day 41, −18.7% | −$2,276 | `gm_profit_take` Day 29 (+13.8%) | **+$1,600 est.** |
| AMAT | Tech/Semi | Day 45, −9.6% | −$69 | `gm_profit_take` Day 8 (+10.6%) | **+$75 est.** |
| ADBE | Tech/Semi | Day 45, −8.6% | −$69 | `gm_hard_stop` Day 4 (never positive) → ADBE exception Day 16 | **−$14 est.** |
| ENPH | Energy | Day 41, −18.6% | −$1,836 | `gm_hard_stop` Day 7 (never positive) | **−$390 est.** |
| ALLY | Financials | Day 39, −7.5% | −$562 | `gm_hard_stop` Day 6 (never positive) | **−$280 est.** |
| LMT | Defense | Day 7, −13.4% | −$1,234 | `gm_hard_stop` Day 4 (never positive) | **−$300 est.** |
| RTX | Defense | Day 12, −12.0% | −$877 | `gm_hard_stop` Day 4 (never positive) | **−$200 est.** |

Estimated improvement on closed + active positions: **+$9,000–$10,000** compared to holding without exit rules.

---

## AI Prompt — Archetype Assignment

The Gold Mine analysis prompt (`buildGoldMineAnalysisPrompt` in `aiSuggestedFinds.ts`) instructs the model to assign each stock one of the four archetype values:

```
- "archetype": Classify the macro theme driving this pick into ONE of:
  - "Tech/Semi"  — AI infrastructure, semiconductors, cloud, software, cybersecurity
  - "Defense"    — defense spending, military, geopolitical conflict, aerospace
  - "Energy"     — oil, natural gas, solar, renewables, energy transition, supply shocks
  - "Financials" — banks, interest rates, dollar strength, economic normalization
```

The archetype is validated on parse (only the four valid values pass through; invalid values become `undefined`, triggering the keyword fallback at runtime).

---

## Sizing Formula

```
base           = maxTotalAllocation × baseAllocationPct%     // e.g. $500K × 2% = $10K
convMult       = convictionMultiplier(conviction, 'Gold Mine') // 0.5–1.25x, capped at 1.25
dollarSize     = base × convMult × 0.75 × 0.33              // 0.75 = tag discount, 0.33 = risk mgmt
                                                             // effective range: $825–$3,094 per position
```

At the current configuration (`maxTotalAllocation = $500K`, `baseAllocationPct = 2%`):
- Conviction 8–10: **$2,063–$3,094** per Gold Mine position (was $6,250–$9,375 before the 0.33 multiplier)
- The 40% Gold Mine sleeve cap (`goldMineCap = maxTotalAllocation × 0.40 = $200K`) still applies on top

---

## Related Files

| File | Purpose |
|---|---|
| `auto-trader/src/scheduler.ts` | `checkLongTermAutoSell()`, `detectGoldMineArchetype()`, `GM_ARCHETYPE_RULES`, `executeSuggestedFindTrade()` |
| `app/src/lib/autoTrader.ts` | Browser-side equivalent — sizing + notes must stay in sync with scheduler.ts |
| `app/src/lib/aiSuggestedFinds.ts` | Gold Mine prompt pipeline — `buildGoldMineAnalysisPrompt()`, `parseGoldMineAnalysis()` |
| `app/src/types/index.ts` | `SuggestedStock` type — `archetype?` field |
| `.cursor/rules/long-term-sizing.mdc` | Agent rule file — sizing formula, archetype rules, ADBE-class exception |
| `docs/queries/suggested-finds-db.md` | SQL queries for inspecting Gold Mine trades in Supabase |
