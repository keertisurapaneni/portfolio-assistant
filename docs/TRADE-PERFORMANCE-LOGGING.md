# Unified Trade Performance Logging

Logging and analytics only — does not modify trading logic.

## Overview

When a trade transitions to CLOSED, a record is written to `trade_performance_log` and rolling metrics are available via API.

## Schema (trade_performance_log)

| Column | Type | Description |
|--------|------|-------------|
| trade_id | UUID | FK to paper_trades, unique |
| ticker | TEXT | Symbol |
| strategy | TEXT | DAY_TRADE \| SWING_TRADE \| LONG_TERM |
| tag | TEXT | Steady Compounder \| Gold Mine \| null |
| entry_trigger_type | TEXT | e.g. bracket_limit, market |
| status | TEXT | CLOSED |
| close_reason | TEXT | eod_close, stop_loss, target_hit, manual |
| entry_datetime, exit_datetime | TIMESTAMPTZ | |
| entry_price, exit_price | NUMERIC | |
| qty | INT | |
| notional_at_entry | NUMERIC | Position size at entry |
| realized_pnl | NUMERIC | |
| realized_return_pct | NUMERIC | |
| days_held | NUMERIC | |
| max_runup_pct_during_hold | NUMERIC | MFE (nullable) |
| max_drawdown_pct_during_hold | NUMERIC | MAE (nullable) |
| regime_at_entry, regime_at_exit | JSONB | { spy_above_50, spy_above_200, vix_bucket } |
| trigger_label | TEXT | EOD_CLOSE \| IB_POSITION_GONE \| EXPIRED_DAY_ORDER \| EXPIRED_SWING_BRACKET |

## CLOSED Finalization Hooks

| Location | Trigger |
|----------|---------|
| App: closeAllDayTrades | EOD_CLOSE |
| App: syncPositions (position gone) | IB_POSITION_GONE |
| App: syncPositions (expired DAY) | EXPIRED_DAY_ORDER |
| Scheduler: syncPositions (position gone) | IB_POSITION_GONE |
| Scheduler: syncPositions (expired DAY) | EXPIRED_DAY_ORDER |
| Scheduler: syncPositions (expired SWING bracket) | EXPIRED_SWING_BRACKET |

## API Endpoints

- `POST /api/trade-performance-log/close` — Body: `{ tradeId, trigger }`
- `GET /api/trade-performance-log/summary?asOf=ISO8601` — Rolling 30d/90d metrics
- `GET /api/trade-performance-log/weekly-report?asOf=ISO8601` — Weekly report

## Run Tests

```bash
cd auto-trader
npm run test
# or
npx tsx src/lib/tradePerformanceMetrics.test.ts
```

## Migration

Run Supabase migrations to create `trade_performance_log`:

```bash
supabase db push
# or apply migrations manually
```
