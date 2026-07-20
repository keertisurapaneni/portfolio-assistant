# Credit spread stale close → orphan shorts (−$22.6k) — 2026-07-20

## What happened

Mon Jul 20 ~9:33 AM ET: `reconcileIBShorts` covered orphan STK shorts:

| Ticker | Qty | Cover | ≈ P&L |
|--------|-----|-------|-------|
| AMD | 100 | $519 | −$6,133 |
| CRDO | 300 | ~$212.52 | −$9,310 |
| ALAB | 200 | $312.97 | −$7,197 |
| **Total** | | | **≈ −$22,640** |

## Root cause

1. Jun 1–2: BULL_PUT credit spreads opened (AMD/ALAB/CRDO), expiry **2026-07-17**.
2. Jun 17: close orders `#54803 / #54796 / #54764` placed (`profit_take_50pct`) — **never filled**.
3. Manager: `if (ib_close_order_id) continue` ran **before** expiry backstop → zombies for 33 days.
4. Jul 17 expiry → long-put exercise shape → orphan shorts over weekend.
5. Jul 20 open: cover at market.

## Fix

`auto-trader/src/lib/credit-spread-scanner.ts`:

- Unfilled close IDs are cancelled + cleared when past expiry, within 7 DTE, or older than 4h.
- Expiry backstop then runs; if a stock cover already exists, spread settles as `expired_assigned_covered` with pnl=0 (no double-count).
- `closed_at` stamped on expiry date so late cleanup doesn't inflate Today's Activity.

Also: `reconcileIBShorts` sums all `ib_fills.realized_pnl` for multi-chunk covers.

## Still open (not this PR)

- Jun 16 inverted-leg entry disease (prevention at place time)
- UI duplicate IB Fill + IBReconcile rows
- Remaining live zombies (SOXL Jul 24, GFS/NOW Aug 21) cleared by new manager on next cycle
