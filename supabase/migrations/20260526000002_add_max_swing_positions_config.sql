-- Add max_swing_positions to auto_trader_config so swing-trade slot pool
-- is configurable independently of the day-trade pool (max_positions).
-- Default 2: allows up to 2 concurrent swing trade positions.
ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS max_swing_positions INTEGER DEFAULT 2;
