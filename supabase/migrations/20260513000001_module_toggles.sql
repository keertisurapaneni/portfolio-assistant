-- Add per-module enable/disable toggles to auto_trader_config.
-- All default to true (enabled) to preserve existing behavior.

ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS trade_signals_enabled   boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS suggested_finds_enabled  boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS options_wheel_enabled    boolean NOT NULL DEFAULT true;
