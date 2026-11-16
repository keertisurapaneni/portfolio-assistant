# 2026-11-13 — Improve % profits / cut losses

## Goal
Net P&L was only ~+$2k over 60 days. User asked for the system to make more profit and take fewer losses; choice of changes was delegated.

## What the data said (paper_trades, filled, ex-reconciliation covers)
- **Swing is the loss center.** Confidence is *inversely* related to outcome for swings:

  | window | conf 7 | conf 8 | conf 9+ |
  |---|---|---|---|
  | 60d | n=22 WR50% +$1,451 | n=17 WR24% −$1,058 | n=6 WR17% −$1,669 |
  | 120d | n=29 +$1,508 | n=23 −$1,852 | n=10 −$784 |

  The 1.5×/2.0× confidence multiplier upsized exactly the losing tiers (avg notional $12.8k vs $10.0k).
- **Day trades** are the opposite: conf 9+ is +$924 (WR 73%) over 60d → upsizing there is kept.
- **Late stops:** 7 swing stops closed >3h after the stop level was crossed (3 overnight) ≈ **$932 excess loss** in 60d. Worst: Nov 5→6, UNH filled $389.24 vs stop $412.12 (~−13R).
- **Tuner changes were being reverted** by the UI full-row config upsert.
- Tested and rejected (replay, not robust): wider swing stops; delayed entry after the open.

## Changes
1. **Software stop backstop** (`auto-trader/src/lib/stop-backstop.ts`, wired in `scheduler.ts` as `runStopBackstop`, cron every 5 min, 9:40–15:58 ET).
   - Candidates: `SWING_TRADE`, `FILLED`, `signal=BUY`, `stop_loss>0`.
   - Breach: Finnhub price ≥0.3% beyond stop, **continuously ≥4 min** (a healthy IB stop fills in seconds; avoids racing it).
   - Action: cancel the leg's TP/SL children → wait 1.5s → re-read IB position **and** DB status → allocate `min(leg qty, remaining IB qty)` per leg → `stampAndPlaceClose` → `recordTradeClose(STOPPED, 'stop_loss')`.
   - Never oversells: split T1/T2 legs share one IB position; position direction must match; flat/mismatch → no order.
   - Failure after cancel: status untouched, ERROR event, retried next run (tracker not reset).
   - Events: `source=stop_backstop` (WARNING on success, ERROR on failure).
2. **Swing confidence upsizing removed** (`confMultiplier = 1.0` for `SWING_TRADE`; day/other modes unchanged).
3. **Tuner clobber fix** (`app/src/lib/autoTrader.ts`): `saveAutoTraderConfig` merges onto the fresh Supabase row (`loadAutoTraderConfig()`), not the localStorage cache.

## Trade-offs / known limits
- Backstop cannot help if IB Gateway is disconnected (no orders possible) — it logs and skips.
- IB-side root cause of the missed stops is **not proven**; the backstop is cause-agnostic.
- Quote source is Finnhub; a bad quote must persist 4 min to act, and null/0 never counts.
- Shorts and `SELL`-signal swing rows are excluded on purpose (SELL rows double as partial-close child records).
- Not done: correlated-entry cap (5 days = ~48% of stop losses); surfacing swing diagnostics in Performance/System Learning tabs.

## Verification
- `npx tsx src/lib/stop-backstop.test.ts` (breach edges, persistence/gap reset, leg allocation incl. split legs, direction mismatch, NaN).
- Read-only dry run vs live rows: 2 open swing legs (JPM, V), both well above stops, selection filters match real rows.
- `npx tsc --noEmit` (auto-trader), `npm run build` (app).

## Deploy
`auto-trader/src` changed → `npm run build` + LaunchAgent restart required (see deployment-workflow rule). Restart outside market hours or with explicit go-ahead.
