-- Add swing_position_size to auto_trader_config
-- Swing trades now use a separate, larger cap ($5K default) so they can generate
-- meaningful income without changing the day trade position size (kept at $1K default).
ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS swing_position_size NUMERIC DEFAULT 5000;

-- Back-fill existing row with the new default so there's no NULL gap
UPDATE auto_trader_config
SET swing_position_size = 5000
WHERE id = 'default' AND swing_position_size IS NULL;
