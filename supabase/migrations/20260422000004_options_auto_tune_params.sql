-- Options auto-tune parameters
-- Adds four tunable columns to auto_trader_config that Rule G adjusts daily after market close.

ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS options_min_iv_rank          INT          NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS options_delta_target         NUMERIC(4,2) NOT NULL DEFAULT 0.30,
  ADD COLUMN IF NOT EXISTS options_profit_close_pct     INT          NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS options_stop_loss_multiplier NUMERIC(4,1) NOT NULL DEFAULT 3.0;

COMMENT ON COLUMN auto_trader_config.options_min_iv_rank IS 'Auto-tuned: minimum IV rank to sell a put (default 50)';
COMMENT ON COLUMN auto_trader_config.options_delta_target IS 'Auto-tuned: target delta for put selection (default 0.30 = 30-delta)';
COMMENT ON COLUMN auto_trader_config.options_profit_close_pct IS 'Auto-tuned: % profit capture threshold for early close (default 50%)';
COMMENT ON COLUMN auto_trader_config.options_stop_loss_multiplier IS 'Auto-tuned: close when premium exceeds this × original (default 3.0×)';
