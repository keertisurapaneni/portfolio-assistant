# Discrepancy Fixes Log

**Purpose:** Track every fix made to resolve Today's Activity vs IB discrepancies.  
Read this file FIRST before making any new fix. If you are about to fix something that already appears here, STOP — you are in a regression loop.

---

## How to Use This File

Before making any fix:
1. Search this file for the ticker/symptom
2. If it already appears — find the root cause column and read it before touching anything
3. After fixing — add a new row immediately

---

## Fix Log

| Date | Symptom | Root Cause | Files Changed | PR | Side Effects / Regressions Introduced |
|------|---------|-----------|---------------|----|---------------------------------------|
| Jun 9 | ADBE not showing in Today's Activity | `closed_at=null` after partial close — `TodayActivityTab` filters `closed_at >= today` | `scheduler.ts` partial close logic | #431 | Incorrect: set close fields on original record. Caused wrong P&L (full qty × close_price). Required PR #434 to fix. |
| Jun 9 | RKLB showing +$298.68 green P&L (phantom) | `syncPositions` matched RKLB OPT position in IB to RKLB STK paper_trade — no `secType` check | `scheduler.ts` `getEnrichedPositions()`, `positions.find()` | #432 | **REGRESSION:** Credit spreads are OPT in IB. STK-only filter caused credit spreads to appear "missing" → 7 spreads falsely closed next morning (SOXL, ALAB, AMD, etc.) |
| Jun 10 AM | 7 credit spreads falsely closed pre-market (SOXL, ALAB, AMD, etc.) | Side effect of PR #432 STK filter — credit spreads are OPT, were no longer found by `syncPositions`, triggered "position missing" fallback | `scheduler.ts` `_syncPositionsForAccount` | #433 | DB repair required: manually reopened 7 records |
| Jun 10 | ADBE and NEM P&L/qty wrong after partial loss cuts | `scheduler.ts` partial close was mutating original record (`remainingQty` × `close_price` = wrong P&L). `reconcileGhostCloses` then closed NEM prematurely using ghost from partial fill | `scheduler.ts` partial close block (~line 7282) | #434 | DB repair required: created child records for ADBE (orders 37825, 39548), NEM (order 43825), reopened RKLB ff945d9a |
| Jun 10 | ASTS loss missing from Today's Activity | `TodayActivityTab.tsx` dedup logic (lines 190-196) filtered `ib_fill_auto_created` ghosts when a real trade existed for same ticker | `paper_trades` DB: changed ASTS ghost `close_reason` from `ib_fill_auto_created` to `loss_cut` | none (DB patch) | None |
| Jun 10 | Duplicate trades from "Execute All" multi-click (FCX, PLTR, QQQ, RKLB, SPY) | No idempotency on "Execute All" button | `TodayActivityTab.tsx` | #429 | None |
| Jun 10 | External trade (QQQ) marking auto-trader signals as "traded" | `TradeIdeas.tsx` didn't filter `strategy_video_id` / `strategy_source` trades from `tradedTickers` | `TradeIdeas.tsx` | #428 | None |
| Jun 10 | Credit spread ghost records created when close fills arrive | `credit-spread-scanner.ts` called `recordTradeClose` BEFORE `ib_close_order_id` was stamped — fills arrived in the ~100ms window, trigger found no match, created ghost | `credit-spread-scanner.ts` | #435 | None |
| Jun 10 | `reconcileGhostCloses` closed NEM prematurely (IB still held 3 shares) | `reconcileGhostCloses` closed real trade when ghost existed, without checking IB live positions | `reconcile-executions.ts` | #435 | None |
| Jun 10 | NBIS `6ab19f67` spuriously closed with `close_reason=manual`, `pnl=0` | **Root cause still unresolved.** Attribution: scheduler SUBMITTED detection path suspected, but CREDIT_SPREAD is `continue`d before that block. Reopened manually. | DB patch: reopened `6ab19f67` | none | Needs investigation — if root cause not found, will recur |
| Jun 10 | Credit spread P&L wrong in Today's Activity (estimated Greeks, not actual fills) | `manageCreditSpreadPositions` called `recordTradeClose` immediately after placing close order with estimated P&L. Trigger couldn't correct it — combo fills have `realized_pnl=null`, trigger section 4 requires `realized_pnl IS NOT NULL` | `credit-spread-scanner.ts`, new trigger section (4b) | #436 | None known |
| Jun 11 | ADBE/NEM loss cut child records showing "BUY" signal instead of "SELL" | PR #434 child record insert used `signal: trade.signal` — inherited `'BUY'` from original LONG_TERM position. Loss cut is a sell action, should be `'SELL'` | `scheduler.ts` line 7301 | #437 | None |
| Jun 11 | OPTIONS_SCALP ORB scanner placed 0 trades silently for 2+ days | `range=2d` returns only ~100 bars; `ORB_SMA200_PERIOD=200` requires ≥200, so `get5mSmaDirection()` always returned null — every ticker skipped as "chopping around 200 SMA". **Validated live**: `range=5d` returns 334 bars, `range=2d` returns 100. | `yahoo-finance.ts`: added `'5d'` to range type. `options-scalp.ts`: `'2d'`→`'5d'`, restored `ORB_SMA200_PERIOD=200`, added data-unavailable log | #438+#439 | None — 200 SMA now actually computable |
| Jun 11 | META short day trade: `ib_close_order_id` stamped with TP order ID instead of SL order ID | Position-sync used `tpId \|\| slId` (TP first, truthy) → always passed TP order ID to `recordTradeClose` even when SL fired. `recordTradeClose` looked for ib_fills by TP order ID, found nothing, fell back to formula. ib_close_order_id got set to wrong order → trigger can never auto-correct. P&L difference was ~$2 (commissions) — **commission differences are acceptable, not treated as discrepancies**. The ib_close_order_id correctness matters for trigger linkage. | `scheduler.ts`: `bracketCloseOrderId` now picks the order ID of whichever fill confirmed. DB patch: `b6ae0e75` — set `ib_close_order_id='44191'`, `pnl=-107.09` | #443 | None. Commission-level P&L differences (~$2) are acceptable. |
| Jun 11 | ADBE loss cut showing +$120.92 instead of -$120.92 (sign-flipped P&L) | Partial loss cut child records have `signal='SELL'` (PR #437 display fix). `trade-closer.ts` line 92 used `signal === 'BUY'` to determine `isLong` → child's 'SELL' → formula used `(fillPrice - closePrice) * qty` = positive instead of `(closePrice - fillPrice) * qty` = negative. `ib_fills.realized_pnl` was null (commission report pending) so trigger never corrected it. Fix: added `positionDirection?: 'LONG'\|'SHORT'` to `CloseTradeParams`; partial loss cut call site passes `ibPos.position > 0 ? 'LONG' : 'SHORT'`. **Root architecture debt:** `signal` serves dual purpose (entry direction + close-action display). Tracked as TODO for `display_action` column. | `auto-trader/src/lib/trade-closer.ts`, `auto-trader/src/scheduler.ts`. DB patch: `f4436094` pnl → -120.93 | #442 | None. `positionDirection` is optional — all existing callers unaffected. **If this P&L sign-flip recurs on any loss cut record, the commission report in ib_fills will eventually overwrite it with the correct value when IB sends it.** |
| Jun 11 | OPTIONS_SCALP 0DTE never implemented — always buying multi-day weekly options | `getNearestWeeklyExpiry()` explicitly picked "next Friday ≥1 day out". Kay Capitals uses same-day expiration (0DTE) exclusively. SPY has 0DTE chains Mon–Fri. Multi-day options have expensive premium and were held overnight when EOD close failed pre-Jun-5. Renamed to `getTodayExpiry()` returning today's ET date. Zero 0DTE trades have ever been placed. | `auto-trader/src/lib/options-scalp.ts` | #444 | First time 0DTE orders will be placed. If IB rejects same-day chain, `executeScalp` returns false → graceful skip (no crash). |
| Jun 12 | GS SWING_TRADE (qty=10, +$347.83) missing from Today's Activity | GTC TP order 39711 fired at 05:48:34 ET before auto-trader connected. Auto-trader missed execDetails callback — no entry in `ib_fills` for the close. `closed_at=null` → `getTodayTrades()` filter missed it. Root cause: `runEndOfDayReconciliation` only queries trades with `opened_at/filled_at >= today` — misses multi-day swing positions like GS (filled Jun 10). | DB patch: `3250c4e7` — `status=TARGET_HIT`, `ib_close_order_id=39711`, `closed_at=2026-06-12T09:48:34Z`, `close_price=1061.04`, `pnl=347.83`, `close_reason=target_hit`. **Permanent fix (Jun 12):** `reconcileMissedBracketFills()` in `reconcile-executions.ts` — queries ALL FILLED trades with bracket order IDs (no date filter), runs at startup +45s via `scheduler.ts`. | `auto-trader/src/lib/reconcile-executions.ts`, `auto-trader/src/scheduler.ts` | (pending PR) | GS qty=11 tranche (`e4fafd99`) still open — bracket untouched. IB auto-cancelled SL 39712 when TP fired. |
| Jun 12 | GOOGL OPTIONS_PUT (qty=1, +$183.77) missing from Today's Activity | `ibBuyToCloseOption` timed out (fill arrived 195+ log lines later). Old code returned `null` on timeout, discarding `orderId`. Caller skipped `recordTradeClose` and never stamped `ib_close_order_id`. Postgres trigger fired 3× (orderStatus insert, execDetails insert, commissionReport update) but found no `ib_close_order_id` match on `paper_trade` each time. | DB patch: `efe775bf` — `status=TARGET_HIT`, `ib_close_order_id=50092`, `closed_at=2026-06-12T15:39:59Z`, `close_price=4.00`, `pnl=183.77`, `close_reason=target_hit`. **Permanent fix (Jun 12):** `IBCloseResult` discriminated union + `stampPendingBtcOrder()` helper in `options-manager.ts`. All 9 call sites updated with `if (ibClose.timedOut)` guard — stamps `ib_close_order_id` immediately, defers `recordTradeClose` to the Postgres trigger. | `auto-trader/src/lib/options-manager.ts` | (pending PR) | Commission report for 50092 may still arrive; trigger may update pnl but delta will be within $1-2 tolerance. |
| Jun 11 | OPTIONS_PUT wheel scanner placed 0 trades for 9 days (May 29 – Jun 11) | Watchlist intentionally cleaned up to 47 active tickers, but all are Tech/Comm Services/Consumer Discretionary. Tech correction → 16 tickers `below_sma50`. 9 open positions (AAPL, AMAT, ADI, CRDO, ORCL, RBRK + 3 more) fill Technology `sector_limit` (MAX=3), blocking 10 more. All 47 blocked — self-locking state. No defensive sector fallback left. | DB only: activated KO (Consumer Staples +6.2% above SMA50), JNJ and ABBV (Health Care +3.9%/+7.3%). Sectors with 0 open positions, tickers you'd want to own if assigned. Migration: `20260611000001_watchlist_activate_defensive_tickers.sql` | none | **Do NOT re-add bulk defensive tickers** — watchlist cleanup was intentional. If scanner goes dry again in future: check which non-Tech sectors have capacity first, then add 1-3 names only. |

---

## Recurring Patterns — Red Flags

If you see any of these, check the log above BEFORE fixing:

| Pattern | Previously caused by | Watch out for |
|---------|---------------------|---------------|
| Credit spread showing wrong P&L | Estimated Greeks (now fixed in #436) | Don't re-add `recordTradeClose` eagerly |
| Credit spread record status=CLOSED unexpectedly | (a) STK filter regression (#432→#433), (b) unknown close_reason=manual path | Check `ib_close_order_id` vs `ib_order_id` — don't confuse entry vs close order |
| Position showing in app but not IB | `reconcileGhostCloses` prematurely closed it | Run `reqPositions()` BEFORE patching DB |
| Position showing in IB but not app | secType mismatch, or record was incorrectly set to CLOSED | Check ib_fills for the order — don't delete records |
| LONG_TERM/SWING_TRADE partial close with wrong qty | Original record mutated (fixed #434) | Never update `quantity` on original — create a child record |
| Ghost record appearing in Today's Activity | ib_fill with no matching `ib_close_order_id` | Check the existing real trade first; don't delete the ghost |

---

## Unresolved Root Causes

These issues were patched at the DB level but the code path that caused them has NOT been identified. They may recur:

1. **NBIS `6ab19f67` spurious close** (Jun 10): Closed with `close_reason=manual`, `pnl=0` within 8 minutes of opening. Suspected: scheduler SUBMITTED detection, but CREDIT_SPREAD is excluded at line 5867. Actual cause unknown.

2. **ASTS third IB mobile row** (Jun 10): IB mobile showed 3 ASTS rows, ib_fills shows only 2 orders (39546, 39550). Could be IB UI splitting execDetails + commissionReport, or a real 3rd fill. Not confirmed.

---

## Architecture Hazards (don't repeat these mistakes)

1. **Never add a filter to `syncPositions` for one secType without auditing impact on other modes.** PR #432 (STK filter) is the canonical example — it fixed one thing and broke 7 spreads.

2. **Never call `recordTradeClose` before `ib_close_order_id` is stamped** — fills can arrive in under 100ms.

3. **Never delete a `paper_trade` that has any IB order ID set** — the trigger already fired, deleting orphans the fill permanently.

4. **Never patch the DB without first checking `reqPositions()`** — if IB still holds the position, the record must stay open.

5. **`paper_trades.pnl` has 5 writers** (trigger, `recordTradeClose`, `scheduler.ts`, `credit-spread-scanner.ts`, `reconcile-executions.ts`). Any change to one can be stomped by another. When debugging wrong P&L, check all 5.

6. **`scheduler.ts` is ~8600 lines.** Guards added in one section do not protect other sections. When adding mode-specific logic, search the ENTIRE file for the mode string.
