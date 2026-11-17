# Option bookkeeping fix + credit-spread entry pause (2026-11-17)

## Goal
Make the DB agree with IB for option settlements (the 60d-vs-90d profit confusion), without
placing any orders. Approved lever: "Fix bookkeeping". Nothing else (put-selling trend gate,
pausing swing, re-enabling LONG_TERM) was approved.

## What was wrong (all verified against code, DB, and the IB statement)
- Option exercise/assignment/expiry settlements create **no commission-report rows**, so they never
  reach `ib_fills` → DB missed ~$20k of the +$38k IB realized over Aug 19–Nov 16.
- `manageCreditSpreadPositions`: `BEAR_PUT_DEBIT_HOLD → continue` ran before the expiry backstop, so
  inverted (net-debit) spreads never settled. The existing backstop assumes credit math (wrong sign
  for these) and uses a live quote instead of the expiry-day close.
- `options-manager`: `if (pos.ib_close_order_id) continue` ran before the expiry check → stale BTC
  stamps blocked expiry forever (NOW $126P, VRTX).
- **Hidden coupling:** the 8 stale spread rows were exactly `MAX_SPREAD_POSITIONS`. The daily 10:30
  scan logged "Max positions reached (8/8)" — the stale rows were the only brake on `autoExecute`.
  Every BULL_PUT entry since Jun 10 (8/8) filled as a net debit; the Jul 20 gate only validates strike
  order. Closing the stale rows therefore *requires* an explicit pause.

## Changes
- `option-settlement.ts` (+ test): payoff maths for inverted spreads, debit parsing, expiry-close
  selection (never guesses; null if the expiry bar isn't final).
- `credit-spread-scanner.ts`: settle expired DEBIT_HOLD rows; subtract an existing
  `ib_reconciliation_cover` P&L to avoid double count; **auto-entry paused** unless
  `CREDIT_SPREAD_AUTO_ENTRY=on`.
- `options-manager.ts`: expired positions no longer blocked by a stale unfilled BTC stamp (cancel,
  clear, proceed; waits if the order has fills); short-put expiry uses the expiry-day close.
- DB patch (fields only; no deletes; IB positions checked first): see discrepancy log row.

## Trade-offs / limits
- Formula settlement is an **estimate** when the long leg was exercised: the resulting stock keeps
  moving until covered (AMD/AMAT/STX/CRDO differed from IB by $0.4k–$2.6k). Legacy rows use IB
  statement values; future rows are labeled `estimated`.
- Not fixed: root cause of inverted legs (IB combo action semantics unverified — needs a controlled
  test, not a blind rewrite), `ib_fills` gaps, VRTX (pre-statement; BTC #139600 unverified).
- Pause preserves the de-facto behavior; re-enabling is a deliberate follow-up decision.
