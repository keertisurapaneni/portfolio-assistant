-- Auto-sell thresholds for LONG_TERM (Suggested Finds) positions.
-- The scheduler checks these on every cycle and closes positions that breach them.

ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS lt_stop_loss_pct    NUMERIC(5,2) NOT NULL DEFAULT -10.0,
  ADD COLUMN IF NOT EXISTS lt_profit_take_pct  NUMERIC(5,2) NOT NULL DEFAULT 15.0,
  ADD COLUMN IF NOT EXISTS lt_max_hold_days    INT          NOT NULL DEFAULT 60;

COMMENT ON COLUMN auto_trader_config.lt_stop_loss_pct   IS 'Long-term stop-loss: close if PnL% drops below this (e.g. -10 = -10%)';
COMMENT ON COLUMN auto_trader_config.lt_profit_take_pct IS 'Long-term profit-take: close if PnL% exceeds this (e.g. 15 = +15%)';
COMMENT ON COLUMN auto_trader_config.lt_max_hold_days   IS 'Long-term max hold: force-close after this many days (0 = disabled)';
