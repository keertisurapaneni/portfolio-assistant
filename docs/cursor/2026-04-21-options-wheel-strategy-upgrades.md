# Options Wheel Engine — Strategy Upgrades

**Date:** 2026-04-21  
**Session type:** Video analysis → implementation (analyst-guided)  
**Analyst persona:** Mary (bmad-agent-analyst)  
**Goal:** Harden the existing options wheel engine based on insights from professional options-selling educators

---

## Context

The initial Options Wheel Engine was built and validated (see `2026-04-20-options-wheel-engine.md`). This session extended it with five rounds of educator video analysis, extracting only the evidence-based rules and discarding the hype.

---

## Videos Analyzed

### Video 1 — Smart Option Seller "80% Rule"
**Source:** smartoptionseller.com  
**Claim:** Close puts when premium has decayed 80% (buy back at $0.20 for every $1.00 sold)  
**Assessment:** Legitimate rule. The educator's core math is sound. However, tastytrade backtests show **50% early exit maximizes annualized return** by recycling capital faster. The 80% rule maximizes per-trade profit but ties up capital ~2× longer.  
**Decision:** Keep our 50% auto-close. Validated as correct.  
**Insight extracted:** The educator correctly distinguishes "80% premium captured" ≠ "80% ROC." The actual return = `(profit / capital_reserved) × (365 / days_held)`. **This was missing from our UI.**

### Video 2 — Tom Sosnoff's "One Trade" (tastytrade 12-delta ES put)
**Source:** tastytrade / Think or Swim  
**Claim:** Sell ES put at 12 delta, 45 DTE, close at 50% profit, hard-close at 21 DTE regardless of P&L  
**Assessment:** Mixed. The underlying tastytrade strategy is well-documented and legitimate. The YouTube presentation inflated returns by conflating margin-return with capital-return, and cherry-picked a bull market window. The "one trade a day on micros" suggestion is dangerously aggressive.  
**Decision:** Ignore the ES futures scope (our system trades stock options). But the **21 DTE hard-close rule** is the real gem — and it was only an alert in our system, not an enforceable close.  
**50% profit target:** confirmed again by tastytrade's own research.

---

## Changes Implemented

### 1. Probability-of-Profit Floor (options-scanner.ts)
```
MIN_PROB_PROFIT = 75%
```
Puts are only considered when the selected strike's OTM probability ≥ 75%.  
Skip reason: `low_prob_profit:XX%` — visible in the diagnostics panel.

### 2. Break-Even Price on Open Position Cards (OptionsTab.tsx)
Position cards now show two rows of stats:
- Row 1: **Strike / Break-Even / Expiry** — break-even ($option_net_price) displayed prominently in violet
- Row 2: Collected / P&L / Captured %

The break-even is the most important defensive number: the stock price the put must stay above.

### 3. Annualized ROC Display (OptionsTab.tsx + optionsApi.ts)
Formula: `(pnl / capital_reserved) × (365 / days_held) × 100`
- **Open positions:** projected annualized ROC badge next to DTE chip (recalculates every manage cycle)
- **History tab:** actual annualized ROC shown under P&L, using exact `opened_at` → `closed_at` days held
- Both use minimum 1 day to avoid division-by-zero on same-day closes

This surfaces the number the educator called "the real return" — separating premium-capture % from capital efficiency.

### 4. Hard Stop-Loss at 200% of Premium (options-manager.ts)
Trigger: `currentPremium > premiumCollected × 3`  
(i.e., the put has moved 2× against us — we've lost twice what we collected)  
Action: Close immediately with `close_reason: 'stop_loss'`  
Log: `🛑 STOP-LOSS` event in activity log, red card in history

Prevents a bad trade from compounding into account-threatening damage.

### 5. Auto-Roll on Strike Threat (options-manager.ts)
Trigger: stock ≥ 5% below strike AND premium grown 1.5×+ AND DTE > 7  
Action:
1. Close current position (`close_reason: 'rolled'`, records the buyback loss)
2. Insert new paper position: strike ~5% below current stock price, +35 DTE, estimated credit ≈ 80% of original premium
3. Note stored on new position: "Rolled from $X (net debit: $Y)"

History shows `↩️ Rolled` badge (blue card) with the roll note inline.

### 6. 21 DTE Hard Close (options-manager.ts) — tastytrade rule
**Changed from:** warning alert only  
**Changed to:** actual position close  
Trigger: DTE ≤ 21 (runs every 30-min manage cycle)  
Rationale: After 21 DTE, theta decay curve flattens while gamma risk accelerates. The remaining 20% of premium is not worth the risk of a sudden move in the final weeks.

Two outcomes:
- Profitable → `close_reason: '21dte_profit'` → `⏱️ 21 DTE Close` (green badge)
- At a loss → `close_reason: '21dte_close'` → `⚠️ 21 DTE Cut` (amber badge)

### 7. Full History Badge System (OptionsTab.tsx)
History cards are now color-coded by exit reason:

| Badge | Colour | close_reason |
|---|---|---|
| ✅ Expired | green | `expired_worthless` |
| 💰 50% Close | green | `50pct_profit` |
| ⏱️ 21 DTE Close | green | `21dte_profit` |
| ⚠️ 21 DTE Cut | amber | `21dte_close` |
| ↩️ Rolled | blue card | `rolled` |
| 🛑 Stopped | red card | `stop_loss` |

Rolled cards also show the roll note (new strike, net debit) inline.

---

## Updated Options Manager Lifecycle

```
Position opened (FILLED)
│
├─ Every 30 min manage cycle:
│   ├─ SUBMITTED order? → check IB open orders → if filled, mark FILLED
│   ├─ DTE ≤ 0? → expire worthless (CLOSED, close_reason: expired_worthless)
│   ├─ currentPremium > 3× collected? → STOP-LOSS close
│   ├─ profitCapture ≥ 50%? → AUTO-CLOSE profit
│   ├─ stock < strike×0.95 AND premium 1.5×+ AND DTE > 7? → AUTO-ROLL
│   └─ DTE ≤ 21? → HARD CLOSE (profit or cut)
│
└─ Assignment check: stock < strike×0.98 → assignment alert (UI)
```

---

## Key Decisions & Rationale

| Decision | Choice | Why |
|---|---|---|
| Profit target: 50% vs 80% | **50%** | tastytrade backtests: 50% maximises annualized ROC via faster capital recycling |
| 21 DTE: alert vs. hard close | **Hard close** | The alert was being ignored; gamma risk is real after 21 DTE |
| Auto-roll vs. manual | **Auto-roll in paper mode** | For live trading this becomes a suggestion; paper mode it executes to validate the math |
| Stop-loss at 200% | **Hard rule** | Prevents one bad trade from dominating the monthly stats |
| Prob profit floor: 75% | **75%** (not 80%) | tastytrade targets 70–85%; we use 75 as a practical floor |

---

## Files Changed

| File | Change |
|---|---|
| `auto-trader/src/lib/options-scanner.ts` | Added `MIN_PROB_PROFIT = 75`, enforced as entry gate |
| `auto-trader/src/lib/options-manager.ts` | Added stop-loss (200%), auto-roll, 21 DTE hard close |
| `app/src/lib/optionsApi.ts` | Added `close_reason`, `closed_at` to `OpenOptionsPosition` interface; updated both queries |
| `app/src/components/PaperTrading/tabs/OptionsTab.tsx` | Break-even row, annualized ROC badge, full history badge system, `calcAnnualizedROC()` helper |

---

## Commits

```
73b5326 Add prob-profit floor, break-even display, auto-roll, and stop-loss
32fac5f Add annualized ROC display to open positions and history (80% Rule insight)
933d63d Add 21 DTE hard close rule (tastytrade protocol)
```
