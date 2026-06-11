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
| Jun 11 | OPTIONS_SCALP ORB scanner placed 0 trades silently for 2+ days | `fetchIntradayBars(ticker, '5m', '2d')` returns `null` from Yahoo Finance — `range=2d` unsupported. All 20 HIGH_VOL tickers silently skipped at `!bars5m?.length` (no log). Also `ORB_SMA200_PERIOD=200` unreachable — max ~78 bars/day. | `options-scalp.ts`: `'2d'`→`'1d'`, period 200→50, added data-unavailable log | #438 | SMA50 on 5-min = ~4h trend filter; equivalent direction signal |

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
