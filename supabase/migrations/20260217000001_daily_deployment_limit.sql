-- Add daily deployment limit and update allocation cap to $500K

-- Daily deployment limit: max NEW capital deployed in a single day
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS max_daily_deployment NUMERIC NOT NULL DEFAULT 50000;

-- Update allocation cap default and current value to $500K
ALTER TABLE auto_trader_config ALTER COLUMN max_total_allocation SET DEFAULT 500000;
UPDATE auto_trader_config SET max_total_allocation = 500000 WHERE id = 'default' AND max_total_allocation = 250000;

COMMENT ON COLUMN auto_trader_config.max_daily_deployment IS 'Max new capital deployed per day to prevent budget blowouts';
