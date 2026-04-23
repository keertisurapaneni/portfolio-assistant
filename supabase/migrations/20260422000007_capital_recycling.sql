-- Capital recycling controls:
--   swing_max_hold_days  — auto-close filled swing trades after N calendar days to free capital.
--                          Default 5 (1 week). 0 = disabled.
--   capital_pressure_enabled — when deployed > 90% of cap AND a new signal arrives,
--                              auto-close the most-profitable open swing trade to make room.

ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS swing_max_hold_days     INT     NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS capital_pressure_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN auto_trader_config.swing_max_hold_days      IS 'Auto-exit filled swing trades after N days (0 = off)';
COMMENT ON COLUMN auto_trader_config.capital_pressure_enabled IS 'When at cap, auto-close best-exit swing trade to make room for new high-conviction signal';
