# P&L Discrepancy Root Cause Fixes — 2026-05-14

## Summary

A full day of debugging P&L discrepancies between our UI and Interactive Brokers.
All root causes were identified and fixed at the code level (no more daily SQL patches).

---

## Root Causes Fixed (8 total)

### 1. Trailing stop not writing close_price/pnl (PR #217)
- **Symptom:** Tickers closed by trailing stop showed $0 P&L
- **Fix:** `checkDayTradeTrailingStops` in `scheduler.ts` now writes `close_price`, `pnl`, `pnl_percent` when closing

### 2. Browser null-price fallback writing pnl=0 (PR #217)
- **Symptom:** WOLF showed $0 P&L when `getQuotePrice` returned null
- **Fix:** Removed fallback to `fillPrice` in `autoTrader.ts` — defers to server-side scheduler instead

### 3. EOD reconciler skipping null close_price trades (PR #217)
- **Fix:** Removed `close_price != null` gate in `reconcile-executions.ts`

### 4. `reconcileIBShorts` covering same-day SELL shorts (PR #218)
- **Symptom:** MSFT showed fake +$394.80 instead of actual small loss
- **Fix:** Added same-day guard — skip tickers with active SELL paper_trades from today

### 5. SELL fill detection gap (PR #218)
- **Symptom:** META stuck as "Pending" forever (no bracket orders = fill never detected)
- **Fix:** `syncPositions` now checks `ib_fills` for SUBMITTED orders to detect fills

### 6. Double EOD close — browser + server both firing (master)
- **Symptom:** Every day trade sold TWICE at 3:55 PM, creating orphaned shorts
- **Fix:** Disabled `scheduleDayTradeAutoClose` in browser (`autoTrader.ts`); added double-close guard in server `closeAllDayTrades`

### 7. Ghost paper_trades showing $0 P&L (PR #221)
- **Symptom:** WOLF/NVDA had second ghost entry with null fill_price marked CLOSED
- **Root cause:** EOD sweep marked unfilled SUBMITTED orders as `CLOSED` instead of `CANCELLED`
- **Fix:** Changed to `CANCELLED/never_filled` so they're excluded from P&L calculations

### 8. Same-day DAY_TRADE re-entry after TARGET_HIT (PR #221)
- **Symptom:** Scanner re-entered WOLF 28 min after target hit, NVDA 36 min after
- **Root cause:** `hasActiveTrade()` only checks SUBMITTED/FILLED/PARTIAL — TARGET_HIT is not "active"
- **Fix:** Added same-day cooldown gate in `executeScannerTrade` for DAY_TRADE mode

### 9. IB FIFO cost basis mismatch — TSLA/AAPL P&L wrong sign (PR #223)
- **Symptom:** TSLA showed -$44.66 in our system, +$95.32 in IB; AAPL -$1.76 vs +$12.94
- **Root cause:** IB's FIFO used cheaper orphaned prior-day lots. We calculated P&L from `fill_price` (today's entry), not IB's actual cost basis
- **Fix:**
  - Capture `realizedPNL` from IB's `commissionReport` event and store in `ib_fills.realized_pnl`
  - `requestExecutions` in reconciler now also collects commission reports (waits 2s after `execDetailsEnd`)
  - EOD reconciler uses IB's `realizedPnl` directly when available instead of recalculating

---

## Other Changes

### UI: Gainers/Losers filter
- Added Gainers (green) and Losers (red) filter buttons to Today's Activity tab

### UI: Signal badge reverted
- Signal column stays as BUY (green) / SELL (red) based on entry direction
- Status column already shows Closed/Active — no need to change the badge

### `reconcileIBLongs` (PR #220)
- Detects untracked IB long positions at startup and 4:10 PM
- Only auto-closes confirmed ghost day-trade longs (matching today's null-fill CANCELLED records)
- Logs "unrecognised portfolio positions" as warnings for manual review — never auto-sells legitimate holdings

---

## Expected Remaining Differences (by design)

- **~$2.11/trade:** IB deducts commissions from displayed P&L; our system shows pre-commission P&L
- **Trade count:** IB counts each execution separately (duplicates from double-close appear as separate entries); our system dedups by trade record

---

## PRs

| PR | Description |
|----|-------------|
| #217 | Trailing stop P&L, browser fallback, reconciler gate, orphaned short reconciliation |
| #218 | Same-day short guard, SELL fill detection |
| #220 | reconcileIBLongs |
| #221 | Ghost trades (CANCELLED), same-day re-entry cooldown |
| #222 | Signal badge (reverted same day) |
| #223 | IB realizedPnl from commissionReport → EOD reconciler |
