-- Loss Cutting + aggressive income strategy update

-- Loss Cutting — auto-sell losers to protect capital
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS loss_cut_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS loss_cut_tier1_pct NUMERIC NOT NULL DEFAULT 8;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS loss_cut_tier1_sell_pct NUMERIC NOT NULL DEFAULT 30;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS loss_cut_tier2_pct NUMERIC NOT NULL DEFAULT 15;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS loss_cut_tier2_sell_pct NUMERIC NOT NULL DEFAULT 50;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS loss_cut_tier3_pct NUMERIC NOT NULL DEFAULT 25;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS loss_cut_tier3_sell_pct NUMERIC NOT NULL DEFAULT 100;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS loss_cut_min_hold_days INT NOT NULL DEFAULT 2;

-- Update profit-taking defaults to be more aggressive (generate income sooner)
UPDATE auto_trader_config SET
  profit_take_tier1_pct = 8,
  profit_take_tier1_trim_pct = 25,
  profit_take_tier2_pct = 15,
  profit_take_tier2_trim_pct = 30,
  profit_take_tier3_pct = 25,
  profit_take_tier3_trim_pct = 30,
  min_hold_pct = 15
WHERE id = 'default';

-- Update dip-buying defaults to be more conservative (don't throw good money after bad)
UPDATE auto_trader_config SET
  dip_buy_tier1_pct = 10,
  dip_buy_tier1_size_pct = 25,
  dip_buy_tier2_pct = 20,
  dip_buy_tier2_size_pct = 50,
  dip_buy_tier3_pct = 30,
  dip_buy_tier3_size_pct = 75,
  dip_buy_cooldown_hours = 72
WHERE id = 'default';

-- Extend source constraint to include loss_cut
ALTER TABLE auto_trade_events DROP CONSTRAINT IF EXISTS auto_trade_events_source_check;
ALTER TABLE auto_trade_events ADD CONSTRAINT auto_trade_events_source_check
  CHECK (source IN ('scanner', 'suggested_finds', 'manual', 'system', 'dip_buy', 'profit_take', 'loss_cut'));

COMMENT ON COLUMN auto_trader_config.loss_cut_enabled IS 'Auto-sell losing positions to protect capital';
COMMENT ON COLUMN auto_trader_config.loss_cut_tier1_pct IS 'Loss % threshold for first partial sell';
COMMENT ON COLUMN auto_trader_config.loss_cut_min_hold_days IS 'Min days held before loss-cutting (avoids intraday noise)';
