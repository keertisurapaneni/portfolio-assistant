# Options Wheel Improvements — 2026-05-12

## Goal

Add a fundamental quality gate to the options scanner, implement a strike sniper feature for manual exploration, and fix three code inconsistencies in the options wheel implementation.

PR: [#201](https://github.com/keertisurapaneni/portfolio-assistant/pull/201)

---

## Part A: Code Consistency Fixes

### A1. Covered call profit target — configurable `profitClosePct`

**Problem:** The put path in `options-manager.ts` correctly used `profitClosePct` from the auto-tuned wheel config, but the covered call path hardcoded `50`. If the auto-tuner adjusted the threshold (e.g. to 45%), calls would still close at 50%.

**Fix:** Changed `if (profitCapturePct >= 50)` to `if (profitCapturePct >= profitClosePct)` in the covered call branch. Updated the event message and metadata to include the configured target, matching the put branch. Also exposed `profitClosePct` and `stopLossMultiplier` on `ManageCycleResult` so the scheduler can reference them in logs/alerts.

**File:** `auto-trader/src/lib/options-manager.ts`

### A2. Delta-targeted call selection

**Problem:** `getOptionsChain` selected `bestPut` via a proper delta-targeting function (`findBestPutStrike` — 6 candidates, delta band ±0.07), but `bestCall` just grabbed the first strike above 105% of spot. This could pick an overly OTM call with poor premium.

**Fix:** Created `findBestCallStrike` mirroring the put function:
- Filters strikes > spot × 1.02 (OTM calls)
- Sorts by proximity to an estimated ~20-delta call strike
- Checks up to 6 candidates for delta within band (0.13–0.27)
- Falls back to first candidate with valid greeks

Replaced the naive `params.strikes.find(s => s > underlyingPrice * 1.05)` with a call to `findBestCallStrike`.

**File:** `auto-trader/src/lib/options-chain.ts`

### A3. Stop-loss alert multiplier

**Problem:** The `sendAlert` body in `scheduler.ts` said "3× the original" while the actual multiplier is configurable via `options_stop_loss_multiplier` in the DB. The alert could lie if the multiplier was changed.

**Fix:** Interpolated `optsMgr.stopLossMultiplier` into the alert template. Also fixed the profit close log to show the actual configured percentage.

**File:** `auto-trader/src/scheduler.ts`

---

## Part B: Fundamental Quality Gate

### New file: `auto-trader/src/lib/fundamental-grader.ts`

Lightweight fundamental scoring using Finnhub `/stock/metric?metric=all` (already used in discovery.ts and watchlist-screener.ts — no new API dependency).

**Metrics scored (6 × ~16.7 points each = 100 max):**

| Metric | Signal | Best score | Worst score |
|--------|--------|------------|-------------|
| P/E ratio | Overvalued penalty | ≤12 → 16.7 | >50 → 1 |
| Debt/Equity | Leverage risk | ≤0.3 → 16.7 | >3.0 → 1 |
| ROE | Profitability | ≥25% → 16.7 | <0% → 1 |
| Revenue growth (YoY) | Growth signal | ≥20% → 16.7 | <-5% → 1 |
| Current ratio | Liquidity | ≥2.0 → 16.7 | <0.7 → 1 |
| Gross margin | Earnings quality | ≥60% → 16.7 | <10% → 1 |

**Grade thresholds:** A (≥80), B (≥65), C (≥50), D (≥35), F (<35)

**Special cases:**
- ETFs/index funds (`is_index_etf` flag) auto-grade B
- Missing API data → neutral C grade
- Results cached in memory with 24h TTL

### Integration: Gate 4.2 in `options-scanner.ts`

Added between the earnings blackout check (gate 4) and news sentiment check (gate 4.5). Stocks graded D or F are skipped before spending API calls on options chain data.

**Files:** `auto-trader/src/lib/fundamental-grader.ts` (new), `auto-trader/src/lib/options-scanner.ts`

---

## Part C: Strike Sniper

A "given a target stock price, find the best put contract across all expirations" feature — different from the delta-targeted scanner. The user specifies what price they want to own a stock at, and the system finds the optimal contract.

### Core logic: `findBestContractForStrike`

Added to `auto-trader/src/lib/options-chain.ts`:
- Gets available expirations from IB via `getOptionChainParams`
- Finds the closest available strike to the user's target
- For each expiration with DTE between 14–90 days, fetches Greeks
- Calculates annualized ROI: `(premium / strike) × (365 / DTE) × 100`
- Returns results sorted by annualized ROI descending
- Accepts optional `minAnnualizedReturn` filter (default 8%)

### API endpoint

New route file `auto-trader/src/routes/options.ts` with:
- `GET /api/options/strike-sniper?symbol=AAPL&targetStrike=180&minReturn=8`
- Returns: current price, target strike, fundamental grade, and ranked contract list

### UI: Sniper tab in OptionsTab.tsx

New "Sniper" section tab in the Options wheel UI:
- Input fields for ticker and target price
- Fundamental grade badge for the stock
- Results table with columns: Expiry, DTE, Strike, Premium, Delta, Ann. ROI, Collateral
- Best contract highlighted with a "BEST" badge
- Color-coded ROI values (green ≥20%, blue ≥10%)

**Files:** `auto-trader/src/lib/options-chain.ts`, `auto-trader/src/routes/options.ts` (new), `auto-trader/src/index.ts`, `app/src/components/PaperTrading/tabs/OptionsTab.tsx`

---

## Key Decisions

1. **Fundamental grader is a gate, not a blocker** — C-graded stocks still pass. Only D/F are filtered. This avoids over-filtering growth stocks with high P/E but strong revenue growth.
2. **Strike sniper is read-only** — it doesn't place orders, just shows opportunities. The user decides whether to act.
3. **24h cache on fundamental grades** — avoids burning Finnhub API calls during the same trading day. Grades don't change intraday.
4. **`findBestCallStrike` uses 0.20 default delta** — matches the ~20-delta intent documented in comments across the codebase for covered call writing.
