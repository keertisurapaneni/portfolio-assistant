-- Add all scanner metadata columns to auto_trade_events.
-- These are persisted by the trend filter, FibRetrace, EMA pullback, and VWAP
-- confluence scanners. Without them, every event from those scanners fails with
-- a PERMANENT schema cache error, breaking activity log visibility entirely.

ALTER TABLE auto_trade_events
  ADD COLUMN IF NOT EXISTS ema100         numeric,
  ADD COLUMN IF NOT EXISTS slope          numeric,
  ADD COLUMN IF NOT EXISTS fib_382        numeric,
  ADD COLUMN IF NOT EXISTS ema9           numeric,
  ADD COLUMN IF NOT EXISTS ema21          numeric,
  ADD COLUMN IF NOT EXISTS ema8           numeric,
  ADD COLUMN IF NOT EXISTS sma200         numeric,
  ADD COLUMN IF NOT EXISTS zone_spread_pct numeric,
  ADD COLUMN IF NOT EXISTS swing_high     numeric,
  ADD COLUMN IF NOT EXISTS swing_low      numeric,
  ADD COLUMN IF NOT EXISTS trend          text;

ALTER TABLE live_trade_events
  ADD COLUMN IF NOT EXISTS ema100         numeric,
  ADD COLUMN IF NOT EXISTS slope          numeric,
  ADD COLUMN IF NOT EXISTS fib_382        numeric,
  ADD COLUMN IF NOT EXISTS ema9           numeric,
  ADD COLUMN IF NOT EXISTS ema21          numeric,
  ADD COLUMN IF NOT EXISTS ema8           numeric,
  ADD COLUMN IF NOT EXISTS sma200         numeric,
  ADD COLUMN IF NOT EXISTS zone_spread_pct numeric,
  ADD COLUMN IF NOT EXISTS swing_high     numeric,
  ADD COLUMN IF NOT EXISTS swing_low      numeric,
  ADD COLUMN IF NOT EXISTS trend          text;
