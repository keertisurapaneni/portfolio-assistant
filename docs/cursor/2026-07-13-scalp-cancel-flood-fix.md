# Options Scalp Cancel Flood Fix (2026-07-13)

## Problem

Trade History was dominated by `CANCELLED` / `ib_error` / `no_fill` rows from `OPTIONS_SCALP`. Most were never real trades — failed IB attempts persisted as History noise.

Today's evidence (Jul 13): 8/8 scalp attempts cancelled. Logs showed Black-Scholes fallback pricing → IB reject (code 200 no security definition, or code 202 limit too far from NBBO).

## Root causes

1. `getOptionGreeksForContract` hardcoded `tradingClass = ticker` (while `placeOptionsOrder` deliberately omits it) → live greeks often failed → BS fallback.
2. `findAtmStrike` Attempt 2 invented interval strikes and treated BS ask as placeable.
3. `executeScalp` / basketball inserted `paper_trades` **before** IB accepted → every reject became a permanent CANCELLED row.

## Fix (option C)

**B — stop placing garbage**
- Omit `tradingClass` on greeks requests; normalize expiry to YYYYMMDD.
- Tag ATM results with `pricingSource`: `live` | `bs_ib_strikes` | `bs_interval`.
- Before place: `resolveOptionConId` must succeed; require live bid/ask (refresh after resolve if needed). BS-only → skip.
- Place with `conId` + resolved expiry.

**A — stop flooding History**
- Insert `paper_trades` only after a confirmed fill.
- Skips/rejects/timeouts → `auto_trade_events` warning only (no CANCELLED row).
- On timeout: still cancel the live IB order to prevent ghost fills.
- If fill succeeds but DB insert fails → CRITICAL error event (IB has position, needs manual link).

## Files

- `auto-trader/src/lib/options-chain.ts`
- `auto-trader/src/lib/options-scalp.ts`
- `auto-trader/src/lib/spy-basketball.ts`
- `auto-trader/src/ib-connection.ts` (export `resolveOptionConId`)

## Expected behavior change

- Fewer (ideally zero) new scalp CANCELLED rows in Trade History.
- Skipped setups appear in activity events, not as fake trades.
- Scalps only open when IB resolves the contract and a live quote exists.
