-- Options auto-trade settings + IB order tracking

-- Add options auto-trade columns to existing config table
ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS options_auto_trade_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS options_max_contracts_per_scan INT NOT NULL DEFAULT 1;

-- Add IB order ID to paper_trades so we can track submitted orders
ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS ib_order_id INT;

COMMENT ON COLUMN auto_trader_config.options_auto_trade_enabled IS 'When true, the options scanner places real IB orders instead of just paper-recording them';
COMMENT ON COLUMN auto_trader_config.options_max_contracts_per_scan IS 'Max number of option contracts to auto-place per morning scan';
COMMENT ON COLUMN paper_trades.ib_order_id IS 'IB Gateway order ID for options auto-trade orders; null for manual/paper-only trades';

-- Bear mode flag on scan results
ALTER TABLE options_scan_results
  ADD COLUMN IF NOT EXISTS bear_mode BOOLEAN NOT NULL DEFAULT false;
