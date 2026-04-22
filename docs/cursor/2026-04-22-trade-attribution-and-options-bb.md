# Trade Attribution Fixes + Options Wheel Bollinger Bands

**Date:** 2026-04-22  
**Session type:** Bug investigation + feature implementation  
**Analyst persona:** Mary (bmad-agent-analyst)

---

## Context

Two parallel workstreams this session:
1. Multi-iteration fix for correct trade attribution in Today's Activity tab
2. Bollinger Band timing signal for the options wheel scanner (from Invest with Henry video)

---

## Problem 1 — Trade Attribution in Today's Activity

### Root cause chain (5 layers deep)

1. **Monday Somesh video was categorized as `generic_strategy`** — user forgot to set it to `daily_signal` after manually assigning the source. Generic videos import signals for ALL scanner tickers, not just the analyst's picks.
2. **12 stale signals (GDX, GLD, MSFT, MSTR, NFLX, IWM, NVDA, SPY, QQQ, AMD, PLTR, GOOGL) from Monday's video got rescheduled to Wednesday** — they all fired under Somesh's name even though Somesh only mentioned META, NVDA, SPY, QQQ in his April 22nd video.
3. **UI had no distinction between signal generators and execution strategies** — `isOurScan` was checking `scannerTickers.has(ticker)` equally for Somesh and Casper, causing Casper's tickers (which legitimately come from our scanner) to be incorrectly labeled as "External signal · Somesh".
4. **Stale video detection missing** — no way for the UI to know a signal came from an old video until `strategy_video_heading` was used to check if it references today's date.

### Final attribution logic

```
event.source === 'scanner'
  → "Trade signal"

event.source === 'external_signal' AND isOurScan AND isExecutionStrategy (Casper)
  → "Trade signal + Casper Clipping"

event.source === 'external_signal' AND isPureExternal (Somesh today's video)
  → "External signal · Somesh"

event.source === 'external_signal' AND stale video (heading ≠ today's date) AND in scannerTickers
  → "Trade signal + Somesh | Day Trader | Investor" (stale, deferred to scanner)
```

`isPureExternal = SIGNAL_GENERATORS.has(stratSource) && isFromTodayVideo`

`isFromTodayVideo` = heading contains today's month + day (e.g. "April 22")

### Key insight

- **Signal generators** (Somesh, Kay Capitals): pick their own tickers with their own entry/exit levels. Even if our scanner has the same ticker, they're independent trades.
- **Execution strategies** (Casper Clipping, Casper SMC Wisdom): apply candlestick/SMC entry rules ON TOP of our scanner's ticker list. Casper's "Candlesticks in a minute" video is educational content — the tickers come from us.

---

## Problem 2 — Systemic Fix: Miscategorization Guard

The root cause of today's mess was leaving a signal generator video as `generic_strategy`. Two guards added:

### Guard 1 — Auto re-import on category change
When `strategy_type` changes to `daily_signal` via the UI:
1. Deletes all PENDING signals for that video
2. Calls `import-strategy-signals` to re-import only transcript tickers
3. Fires automatically — no manual cleanup

### Guard 2 — Warning in assignment UI
- Assigning to Somesh/Kay Capitals auto-defaults category dropdown to `Daily signal`
- Amber `⚠ Should be Daily signal` warning if left as Generic strategy

---

## Feature — Bollinger Band Timing Signal (Options Scanner)

### Insight source
"Invest with Henry" video on selling puts. Key insight: wait for price to touch the **lower Bollinger Band** before entering — this is when IV is elevated, stock is oversold, and the OTM cushion is largest.

### Implementation

**BB computation** (zero extra API calls — uses same 30-day candle fetch as dip detection):
```
SMA20 = mean of last 20 closes
stdDev = sqrt(variance of last 20 closes)
bbLower = SMA20 - 2 × stdDev
bbUpper = SMA20 + 2 × stdDev
```

**Timing signal:**
- `at_lower`: price ≤ bbLower → highest conviction entry, +1 contract
- `near_lower`: price ≤ bbLower × 1.05 → good entry
- `null`: price in normal range

**Contract scaling updated** (stacking order):
```
base (prob_profit + IV rank + RSI)  → 1, 2, or 3
+ dip entry bonus                   → +1
+ BB at_lower bonus                 → +1
cap at 3
```

**DB:** `bb_lower`, `bb_upper`, `bb_signal` columns added to `options_scan_results` (migration `20260422000003`).

---

## Other Changes This Session

- **Options Wheel visible to all users** — removed `isAuthed` guard from route and NavLink
- **"Today" tab removed** from Options Wheel UI — open positions and watchlist are the daily views
- **Watchlist live prices** — Finnhub real-time quote shown on each watchlist card
- **Open position details** — "Placed [date]", delta badge, scanner reason shown on position cards
- **Auto-populate descriptions** — adding a ticker auto-fetches company description from Finnhub
- **Projected monthly income** — total premium locked across all open puts shown in stats
- **Trade Ideas smart refresh** — only auto-refreshes during market hours (7AM–6PM ET, weekdays) with 45-min cache. Manual refresh always available.
- **TRADED badge** — filtered to only show for DAY_TRADE / SWING_TRADE activity from today

---

## Files Changed

| File | Change |
|------|--------|
| `app/src/components/PaperTrading/tabs/TodayActivityTab.tsx` | Signal generator vs execution strategy attribution, stale video detection, specific strategy name in label |
| `app/src/lib/strategyVideoQueueApi.ts` | Added `reimportSignalsForVideo`, `KNOWN_SIGNAL_GENERATORS` |
| `app/src/components/PaperTrading/tabs/StrategyPerformanceTab.tsx` | Auto re-import on category change, amber warning for miscategorized signal generators |
| `auto-trader/src/lib/options-scanner.ts` | BB computation, updated contract scaling, bbSignal field |
| `app/src/lib/optionsApi.ts` | BB fields on OptionsScanOpportunity, projectedMonthlyIncome in stats |
| `app/src/components/PaperTrading/tabs/OptionsTab.tsx` | Removed Today tab, added live prices, open position details |
| `app/src/App.tsx` | Options Wheel visible to all users |
| `app/src/components/TradeIdeas.tsx` | Smart refresh with market hours check and localStorage cache |
| `supabase/migrations/20260422000001_options_watchlist_new_tickers.sql` | Backfill descriptions for SNOW, NOW, CRDO, AVGO |
| `supabase/migrations/20260422000002_options_watchlist_alab_app_amd.sql` | Backfill descriptions for ALAB, APP, AMD |
| `supabase/migrations/20260422000003_options_scan_bb_signal.sql` | Add bb_lower, bb_upper, bb_signal to options_scan_results |

---

## Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| BB at_lower → +1 contract | Yes | Henry's insight: lower band = IV elevated + biggest OTM cushion = high conviction entry |
| Stale video detection | heading contains today's month+day | Simple, reliable, no extra DB query |
| Signal generator distinction | Hardcoded set in UI | Avoids DB join; fast; small set of known generators |
| Generic → daily_signal triggers re-import | Automatic | Prevents the exact bug that caused today's misattribution |
| "Today" tab removal | Removed | Open positions is what matters daily; opportunities tab added noise |
