# Swing BUY extended-move gate (2026-07-16)

## Goal

Stop swing BUY entries into names already in a sharp 10-day dump (falling knives), after IREN −$985 stop-out.

## What happened

- IREN opened Jul 15 as split-bracket swing BUY (379 sh, T1/T2), stopped Jul 16 via IB STP.
- Not an execution bug — shared stop + T1/T2 by design; `close_reason=stopped`.
- At entry, IREN was already **−16% over 10 trading days**. ORCL Jun 29 was **−20%** and also stopped hard.

## Asymmetry (root cause)

Swing **SELL** already hard-blocks when the stock is down >12% in 10 days (`skipped:swing_short_extended`). Swing **BUY** only had SPY regime *sizing* haircuts — no stock-level hard gate.

## Decision (automated — party mode)

Ship BUY mirror of SELL Gate C. Do not change T1/T2 stops or R:R floor.

| Ticker | Entry day | 10d drop | Gate would… |
|--------|-----------|----------|-------------|
| IREN | Jul 15 | −16% | **block** |
| ORCL | Jun 29 | −20% | **block** |
| NU, MELI, JPM, GS, FCX (winners) | various | not extended | **allow** |

## Change

`auto-trader/src/scheduler.ts` — before `spyRegimeMult`:

- If `SWING_TRADE` + `BUY` and 10-day drop > 12% → `skipped:swing_long_extended`
- Yahoo failure → fail-open (same as SELL)

## Out of scope

- Per-leg stops / trail after T1
- UI “Loss Cut” vs “Stopped Out” label (separate UX)
- Raising swing R:R floor
