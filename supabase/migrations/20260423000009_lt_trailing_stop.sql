-- Trailing stop support for LONG_TERM (Suggested Finds) positions.
-- price_peak tracks the highest price seen since entry, updated each scheduler cycle.
-- The trailing stop fires only when price_peak > fill_price (was ever in profit).

ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS price_peak       NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS price_peak_date  DATE;

COMMENT ON COLUMN paper_trades.price_peak      IS 'Highest market price seen since position opened (LONG_TERM trailing stop)';
COMMENT ON COLUMN paper_trades.price_peak_date IS 'Date price_peak was last updated';

-- Replace fixed stop-loss with trailing stop in config
ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS lt_trailing_stop_pct NUMERIC(5,2) NOT NULL DEFAULT 10.0;

COMMENT ON COLUMN auto_trader_config.lt_trailing_stop_pct IS
  'Long-term trailing stop: close if price falls this % from peak (only fires if peak > entry price)';

-- Disable the fixed stop-loss (replaced by trailing stop)
UPDATE auto_trader_config SET lt_stop_loss_pct = 0 WHERE TRUE;
