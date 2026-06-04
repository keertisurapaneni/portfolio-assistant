-- Add missing metadata columns to auto_trade_events that the FibRetrace and EMA
-- pullback scanners try to persist. Without these, every event from those scanners
-- fails with a PERMANENT error, breaking the activity log for those signal sources.

ALTER TABLE auto_trade_events
  ADD COLUMN IF NOT EXISTS fib_236      numeric,
  ADD COLUMN IF NOT EXISTS adx          numeric;

-- Mirror on live_trade_events
ALTER TABLE live_trade_events
  ADD COLUMN IF NOT EXISTS fib_236      numeric,
  ADD COLUMN IF NOT EXISTS adx          numeric;
