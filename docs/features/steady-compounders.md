# Steady Compounders — Long-Term Quality Accumulation

Steady Compounders are the other half of the Suggested Finds system (see [Suggested Finds](./suggested-finds.md)). They are high-quality businesses held over months to years with the goal of compounding capital in fundamentally strong stocks — not reacting to macro catalysts.

---

## What a Steady Compounder Is

A Steady Compounder is selected for:
- **High ROE** (≥15%) and **expanding profit margins**
- **Consistent EPS growth** across multiple quarters
- **Reasonable valuation** (low P/E relative to growth rate)
- **Low beta** — less volatile than the broad market
- **No dependency on a macro theme** — the business compounds regardless of geopolitical events

Sub-labels used in `scanner_reason`: `Quiet Compounder`, `Steady Compounder`.

---

## Historical Performance — What Went Wrong

### Closed positions (as of Apr 2026)

| Ticker | Entry    | Exit     | P&L %  | Days | Peak close | Post-exit recovery | Issue |
|--------|----------|----------|--------|------|------------|--------------------|-------|
| POOL   | Feb 17   | Mar 30   | -25.45% | 41  | -5.91%    | +16.4% (sold at bottom) | 8 total entries, never positive |
| AOS    | Feb 17   | Mar 30   | -19.52% | 41  | -0.64%    | +4.5%              | Never positive, bad entry timing |
| DGX    | Feb 13   | Mar 30   | -6.56%  | 45  | +0.29%    | +4.3%              | 1 positive day, macro sweep exit |
| FAST   | Feb 13   | Mar 30   | -1.99%  | 45  | +2.54%    | +8.8%              | 12/32 positive days — was working |

**Total realized losses: -$8,619**

### Root causes identified

1. **Mass stop-out on a 7% SPY dip (Mar 30)** — The `checkLossCutOpportunities` function swept all LONG_TERM positions at once during a shallow macro pullback. Quality business theses don't change in 41 days based on a 7% SPY move.

2. **POOL dip buy trap** — The dip buy system fired 8 separate times on POOL (SC + dip buys) without checking: (a) how many entries already existed, (b) whether the stock had any positive closes. Capital compounded into a falling knife.

3. **Entry timing** — Several entries occurred near 52-week highs (TJX at -3% from high, DG at +45% above low). True compounder buys should be at or near 52-week lows.

4. **No thesis re-validation gate** — RSG and POOL never closed above their entry price in 14–17 days, yet the dip buy system would have continued firing on price triggers.

---

## Rules in Place (Post-Fix)

### 1. Macro Circuit Breaker — no mass stop-outs during selloffs

**Location:** `checkLossCutOpportunities()` and `checkLongTermAutoSell()` in `scheduler.ts`

If SPY 5-day rolling change ≤ -5%, all LONG_TERM loss cuts and stop-losses are **suspended for that cycle**. The circuit breaker re-evaluates each subsequent run — so if SPY stays down it eventually clears, but it won't trigger during a single-day crash that recovers the next session.

Rationale: SPY dropped 7% Feb→Mar, all compounders got swept Mar 30, POOL then rallied +16%. The business thesis wasn't broken — the macro was.

### 2. Thesis Gate — no dip buys into zombies

**Location:** `checkDipBuyOpportunities()` in `scheduler.ts`

Before firing a dip buy, the system checks:
- `daysHeld >= 20` AND `price_peak <= fill_price * 1.001`

If both are true (stock has never closed above entry after 20 days), the dip buy is **blocked** and logged as `thesis gate: zombie`. The position needs manual fundamental review before adding more capital.

Rationale: POOL and RSG never had a single positive close day. Adding more capital to a stock that never demonstrates any buy-side conviction is catching a falling knife, not averaging into value.

### 3. Cross-Channel Entry Cap — max 3 per ticker

**Location:** `checkDipBuyOpportunities()` in `scheduler.ts`

All open LONG_TERM positions are counted per ticker (SC + dip buys combined). If `totalEntries >= 3`, no additional dip buy fires.

Rationale: POOL accumulated 8 entries across two channels (SC + dip buys). At a max of 3, capital exposure per ticker is bounded.

### 4. Same-Day Duplicate Guard

**Location:** `executeSuggestedFindTrade()` / `_executeSuggestedFindTradeInner()` in `scheduler.ts`

Two guards prevent duplicate orders:
- **In-memory `_sfInFlight` set** — race-condition guard for same-cycle concurrent calls
- **Same-day DB check** — queries `paper_trades` for any LONG_TERM entry for the same ticker on the same ET calendar date; blocks if found

Rationale: TEN opened two identical positions on Apr 21 (5 seconds apart). Both guards prevent this going forward.

### 5. 52-Week Entry Filter (Soft Rule — enforced by AI prompt)

The AI prompt for Compounder generation is guided to only surface stocks that are:
- Within 15% of their 52-week low, **OR**
- Below their 200-day MA

Entries near the 52-week high (within 5%) should be flagged in the scanner_reason as `Near 52wk high — wait for pullback`.

### 6. Profit Trim Tiers

**Location:** `checkProfitTakeOpportunities()` in `scheduler.ts`

| Tier | Gain threshold | Trim | Min hold |
|------|---------------|------|----------|
| 1    | +8%           | 25%  | 15% of original qty always kept |
| 2    | +15%          | 30%  | 15% of original qty always kept |
| 3    | +25%          | 30%  | 15% of original qty always kept |

The remaining position (~45–55% of original after full tiers) is held long-term. The freed capital is recycled into new Compounders or dip buys on the same or other tickers.

### 7. Smart Dip Rebuy After Trim

After a position is trimmed at +8%, if it subsequently dips -10% from the fill price the dip buy system can fire a re-entry (subject to the thesis gate and entry cap). This creates the accumulate-on-dips cycle:
1. Entry → hold → trim at +8% → hold remainder
2. If dip: re-buy (thesis gate passes — stock has positive closes) → hold → trim again

### 8. Weekly Health Check — every Friday 3:30 PM ET

**Location:** `runCompoundersHealthCheck()` in `scheduler.ts`, scheduled via cron

For each active Compounder, computes:
- **positiveDayRatio**: fraction of trading days since entry that closed above fill price
- **healthScore**: 0–10 (10 = always above entry)
- **status**: `strong` | `healthy` | `watch` | `zombie`

Status definitions:
- `zombie` — 0 positive closes after 20+ days → manual review required, dip buys blocked
- `watch` — positiveDayRatio < 0.30 after 20+ days → accumulate cautiously
- `healthy` — positiveDayRatio ≥ 0.30 OR held < 20 days
- `strong` — gainPct ≥ +5% OR positiveDayRatio ≥ 0.60

Results are logged and persisted as `auto_trade_events` (action: `health_check`). Profit-trim hints surface for positions at +5% or +10%.

---

## Exit Logic Summary

| Scenario | Action | Suppressed by? |
|----------|--------|----------------|
| Gain ≥ +8% | Trim 25% of position | Never |
| Gain ≥ +15% | Trim 30% more | Never |
| Down ≥ -8% | Loss cut Tier 1: sell 30% | SPY 5d ≤ -5% |
| Down ≥ -15% | Loss cut Tier 2: sell 50% | SPY 5d ≤ -5% |
| Down ≥ -25% | Loss cut Tier 3: full exit | SPY 5d ≤ -5% |
| Down from peak ≥ trailing stop | Trailing stop exit | Only if peak was above entry |
| Max hold days elapsed | Full exit | Never (set to 0 = disabled) |

---

## Sizing Formula

Compounders use the standard LONG_TERM sizing with no discount (unlike Gold Mines which apply a 0.33x multiplier):

```
base = maxTotalAllocation * baseAllocationPct%     // e.g. $500K * 2% = $10K
dollarSize = base
           * convictionMultiplier(conviction, 'Steady Compounder')  // 1.0–1.5x
           * sma200Multiplier                                         // 0.5 if SPY < SMA200
           * 1.0                                                      // no drawdown multiplier
```

**Hard cap:** No single Compounder position should exceed 1.5x base allocation (~$15K at $500K portfolio). The Feb 17 POOL position at $24,955 (2.5x) was a sizing error and the primary driver of the -$6,593 loss.

---

## Dip Buy Rules (Compounders Only)

| Rule | Value | Rationale |
|------|-------|-----------|
| Max entries per ticker | 3 (cross-channel) | Prevents POOL trap |
| Thesis gate | Block if 0 positive closes after 20d | No zombies |
| Cooldown between dip buys | 72 hours | Avoid rapid accumulation |
| Tier 1 dip threshold | -10% from fill | Meaningful pullback, not noise |
| Gold Mine Tier 3 dip | Blocked | GM holds are short; no deep dip accumulation |

---

## Simulation — What the Rules Would Have Done (Feb–Mar 2026)

| Rule | Would have prevented | Est. saved |
|------|---------------------|-----------|
| Macro circuit breaker (SPY -5%) | Mar 30 mass stop-out | +$5,700 (DGX, FAST, partial POOL) |
| Max 3 entries per ticker | POOL entries 4–8 | +$3,200 |
| Thesis gate | POOL dip buys 5–8 after Apr 6 | +$600 (current open losses) |
| Same-day dup guard | TEN double position | -$12,487 over-exposure prevented |
| **Total estimated improvement** | | **+$9,500+** |

---

## Related Files

| File | Role |
|------|------|
| `auto-trader/src/scheduler.ts` | `checkLongTermAutoSell`, `checkDipBuyOpportunities`, `checkLossCutOpportunities`, `checkProfitTakeOpportunities`, `runCompoundersHealthCheck`, `executeSuggestedFindTrade` |
| `app/src/lib/autoTrader.ts` | Browser-side equivalents of sizing and position management |
| `app/src/lib/aiSuggestedFinds.ts` | AI prompt for Compounder generation + parsing |
| `docs/features/suggested-finds.md` | Full Suggested Finds pipeline |
| `docs/features/gold-mines.md` | Gold Mine archetype rules (parallel system) |
| `.cursor/rules/long-term-sizing.mdc` | Sizing formula and position rules reference |
