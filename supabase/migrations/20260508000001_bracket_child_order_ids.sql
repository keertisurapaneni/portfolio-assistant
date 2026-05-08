-- Add columns to store bracket child order IDs so we can look up actual IB fill
-- prices for take-profit and stop-loss exits (not just entry fills).
ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS ib_tp_order_id text,
  ADD COLUMN IF NOT EXISTS ib_sl_order_id text;
