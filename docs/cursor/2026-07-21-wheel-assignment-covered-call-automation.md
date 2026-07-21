# Wheel Assignment → Covered Call Automation

**Date:** 2026-07-21
**Trigger:** ORCL 100 shares (assigned Jul 10) flagged as an orphan long every morning, never sold or managed.

## Problem

When a cash-secured put is assigned, the auto-trader owns 100 shares/contract. Before this change:

- `handleAssignment()` closed the put (pnl=0, correct) but only **logged** "covered call queued" — it created no share record and sold no call.
- The early-detection path (Check 5) inserted an `OPTIONS_CALL` row **without an `ib_order_id`**, so the 4:10 PM EOD sweep auto-discarded it as a paper-only trade.

Net result: assigned shares sat unmanaged in IB. `reconcileIBLongs()` (warn-only for longs) flagged them as an orphan every day. This is a wheel-strategy gap, unrelated to the Suggested Finds pause.

## Fix

All in `auto-trader/src/lib/options-manager.ts` + one hook in `scheduler.ts`.

### 1. `ensureCoveredCallForAssignedShares({ ticker, acquisitionPrice, contracts })`

Single source of truth for post-assignment covered calls.

- **Idempotent** — no-op if an open `OPTIONS_CALL` already exists for the ticker.
- Places a **real IB order** (`SELL` call), so the record carries an `ib_order_id` and survives the EOD paper-only discard.
- **Three-guard strike** (SMB "deadly mistake"): `max(costBasis, 10% OTM floor, 20Δ chain strike)` — never sell a call below the share cost basis.
- 20Δ, ~45 DTE, conservative bid premium.
- **Defers** (returns without inserting) if IB is disconnected or the chain has no premium — a later cycle retries. No discardable paper rows.

### 2. Wired into both assignment paths

`handleAssignment()` (expiry ITM) and Check 5 (early DTE≤5 detection) both call the helper.

### 3. `reconcileAssignedWheelShares()` — self-heal

Finds IB stock longs that came from a put assignment (`close_reason='assigned'` put within 180d) but have no open covered call, and sells one. Fixes shares stranded before this automation existed (ORCL) or when a prior cycle deferred. Runs each options manage cycle (30-min).

### 4. `reconcileIBLongs()` — stop the false orphan warning

A long is treated as wheel-managed (not an orphan) when it has an open `OPTIONS_CALL` **or** a ≤180d assigned put.

## Design decisions

- **No `LONG_TERM` share record.** The open covered call *is* the tracking artifact. This avoids touching the 4+ LONG_TERM management filters (auto-sell, profit-take, loss-cut, health check) that would otherwise try to sell the shares out from under the call.
- **Manage, don't delete.** Per the paper-account rules, IB holds the shares, so we never DB-patch them away — we sell a call against them.
- **After-hours safety.** The call rests as GTC LMT; ORCL's places at the next RTH manage cycle.
