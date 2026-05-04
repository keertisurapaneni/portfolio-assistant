# Options Wheel & Auto-Trader Bug Fixes — 2026-05-04

## Goal

Fix a cluster of bugs discovered during a party-mode strategy review that were silently degrading the options wheel / LONG_TERM suggested finds strategy: inaccurate P&L recording, ineffective re-entry guards, and structurally inappropriate instruments entering the universe.

---

## Changes Shipped

### 1. SELL `fill_price` Bug Fix — `auto-trader/src/scheduler.ts`

**Problem:** `syncPositions` used `ibPos.avgCost` for the `fill_price` of SELL records when syncing from `SUBMITTED → FILLED`. `avgCost` is the cost basis of *remaining* shares, not the sale price. All loss-cut and profit-take SELL records showed `fill_price ≈ entry_price`, making closed P&L appear as zero.

**Cascading effect:** The `hasRecentLoss` gate reads `fill_price − entry_price` to determine if a position closed at a loss. With fill_price wrong, no losses were ever detected → tickers could be re-bought immediately after being stopped out.

**Fix:**
```typescript
const fillPrice = trade.signal === 'SELL'
  ? (trade.entry_price ?? ibPos.mktPrice)   // market price at order submission
  : ibPos.avgCost;                           // cost basis for BUY
```

---

### 2. Repeated Stop-Out Gate — `auto-trader/src/scheduler.ts` + `auto-trader/src/lib/supabase.ts`

**Problem:** Stocks like POOL were repeatedly bought and stopped out because the 21-day recent-loss gate is time-based only. Once 21 days elapsed, the system re-entered regardless of how many prior stop-outs existed.

**Fix:** New `countRecentStopOuts(ticker, lookbackDays)` function in `supabase.ts` queries `paper_trades` for SELL rows with `entry_trigger_type = 'loss_cut'` within the window. Gate added to `_executeSuggestedFindTradeInner`:

```typescript
const stopOuts = await countRecentStopOuts(ticker, 90);
if (stopOuts >= 3) return 'skipped:repeated_stop_out';
```

---

### 3. Leveraged/Inverse ETF Blocklist — `auto-trader/src/scheduler.ts`

**Problem:** SOXL (3× leveraged ETF) appeared in LONG_TERM open positions. Daily volatility reset and compounding decay make leveraged ETFs structurally incompatible with a buy-and-hold compounding strategy. High IV makes them attractive to the AI screener.

**Fix:** Hardcoded `LEVERAGED_ETF_BLOCKLIST` set checked at entry to `_executeSuggestedFindTradeInner`:

```
SOXL, SOXS, TQQQ, SQQQ, SPXL, SPXU, UVXY, SVXY,
LABU, LABD, NUGT, DUST, JNUG, JDST, FAS, FAZ,
TNA, TZA, NAIL, DRN, DRV, DFEN, WEBL, WEBS
```

Note: these tickers may still appear in the options wheel watchlist (with special HIGH_VOL parameters). The block only applies to the LONG_TERM buy-and-hold path.

---

### 4. Naked Short Prevention — Scanner SELL Signals

**Problem:** Scanner SELL signals (e.g. CRCL, EBAY) attempted to open short positions when no long position existed.

**Fix:** Added guard in both execution paths:
- `auto-trader/src/scheduler.ts` → `executeScannerTrade`
- `app/src/lib/autoTrader.ts` → `processSingleIdea`

If signal is SELL and no IB long position exists → skip with `skipped:no_long_to_sell`.

---

### 5. `import-strategy-signals` — One Row Per Entry Level

**Problem:** For signals with multiple target prices sharing one entry level (e.g. `longTriggerAbove: 414` with targets `[420, 425, 430]`), the function created one DB row per target. This violated the `uq_pending_signal_per_date` unique index on `(ticker, signal, entry_price, execute_on_date)` for PENDING status.

**Fix:** Create exactly one BUY row per `longTriggerAbove` and one SELL row per `shortTriggerBelow`. All targets summarised in the `notes` field (`T1: 420, T2: 425, T3: 430`).

---

### 6. Trade Date Extraction — Day-of-Week Reconciliation

**Problem:** A transcript saying "Monday May 4th" was extracted as "May 5th" because the LLM picked the nearest future instance of May 4.

**Fix:** `extract-strategy-metadata-from-transcript` post-processes the extracted `trade_date` to reconcile against any named weekday in the transcript. If the extracted date's day-of-week doesn't match the named day, the named day wins (adjusted within ±3 days).

---

### 7. Day Trade Cache TTL — 390 → 30 Minutes

**Problem:** `day_trades` results were cached for 390 minutes (full trading day), preventing intraday refreshes.

**Fix:** `trade-scanner/index.ts` `writeToDB` call for `day_trades` changed from `390` to `30` minutes TTL.

---

## Key Files

| File | Change |
|------|--------|
| `auto-trader/src/scheduler.ts` | fill_price SELL fix, stop-out gate, leveraged ETF blocklist, naked short guard |
| `auto-trader/src/lib/supabase.ts` | `countRecentStopOuts()` function added |
| `app/src/lib/autoTrader.ts` | Naked short guard in browser execution path |
| `supabase/functions/import-strategy-signals/index.ts` | One row per entry level |
| `supabase/functions/extract-strategy-metadata-from-transcript/index.ts` | Day-of-week date reconciliation |
| `supabase/functions/trade-scanner/index.ts` | Cache TTL 390 → 30 min |
