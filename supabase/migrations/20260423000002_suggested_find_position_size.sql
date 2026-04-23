-- Flat dollar size per Suggested Find position (0 = use dynamic sizing formula).
-- Default $2,000 keeps the long-term sleeve conservative during the paper testing phase.
ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS suggested_find_position_size INT NOT NULL DEFAULT 2000;

COMMENT ON COLUMN auto_trader_config.suggested_find_position_size IS
  'Flat $ per Suggested Find buy (0 = use baseAllocationPct dynamic sizing)';
