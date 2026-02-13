-- Smart Dynamic Trading System — new config columns for position sizing,
-- dip buying, profit taking, market regime, sector limits, earnings avoidance,
-- and Kelly adaptive sizing.

-- ── 1. Extend auto_trader_config with new columns ──

-- Allocation Cap
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS max_total_allocation NUMERIC NOT NULL DEFAULT 250000;

-- Dynamic Position Sizing
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS use_dynamic_sizing BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS portfolio_value NUMERIC NOT NULL DEFAULT 1000000;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS base_allocation_pct NUMERIC NOT NULL DEFAULT 2.0;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS max_position_pct NUMERIC NOT NULL DEFAULT 5.0;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS risk_per_trade_pct NUMERIC NOT NULL DEFAULT 1.0;

-- Dip Buying
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS dip_buy_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS dip_buy_tier1_pct NUMERIC NOT NULL DEFAULT 5.0;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS dip_buy_tier1_size_pct NUMERIC NOT NULL DEFAULT 50.0;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS dip_buy_tier2_pct NUMERIC NOT NULL DEFAULT 10.0;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS dip_buy_tier2_size_pct NUMERIC NOT NULL DEFAULT 75.0;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS dip_buy_tier3_pct NUMERIC NOT NULL DEFAULT 15.0;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS dip_buy_tier3_size_pct NUMERIC NOT NULL DEFAULT 100.0;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS dip_buy_cooldown_hours INT NOT NULL DEFAULT 24;

-- Profit Taking
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS profit_take_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS profit_take_tier1_pct NUMERIC NOT NULL DEFAULT 25.0;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS profit_take_tier1_trim_pct NUMERIC NOT NULL DEFAULT 20.0;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS profit_take_tier2_pct NUMERIC NOT NULL DEFAULT 50.0;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS profit_take_tier2_trim_pct NUMERIC NOT NULL DEFAULT 25.0;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS profit_take_tier3_pct NUMERIC NOT NULL DEFAULT 75.0;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS profit_take_tier3_trim_pct NUMERIC NOT NULL DEFAULT 25.0;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS min_hold_pct NUMERIC NOT NULL DEFAULT 30.0;

-- Market Regime
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS market_regime_enabled BOOLEAN NOT NULL DEFAULT true;

-- Sector Limits
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS max_sector_pct NUMERIC NOT NULL DEFAULT 30.0;

-- Earnings Avoidance
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS earnings_avoid_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS earnings_blackout_days INT NOT NULL DEFAULT 3;

-- Kelly Adaptive Sizing
ALTER TABLE auto_trader_config ADD COLUMN IF NOT EXISTS kelly_adaptive_enabled BOOLEAN NOT NULL DEFAULT false;

-- ── 2. Extend auto_trade_events source constraint to include dip_buy and profit_take ──

ALTER TABLE auto_trade_events DROP CONSTRAINT IF EXISTS auto_trade_events_source_check;
ALTER TABLE auto_trade_events ADD CONSTRAINT auto_trade_events_source_check
  CHECK (source IN ('scanner', 'suggested_finds', 'manual', 'system', 'dip_buy', 'profit_take'));

COMMENT ON COLUMN auto_trader_config.max_total_allocation IS 'Hard cap on total deployed capital for testing period';
COMMENT ON COLUMN auto_trader_config.use_dynamic_sizing IS 'Enable conviction-weighted + risk-based position sizing';
COMMENT ON COLUMN auto_trader_config.portfolio_value IS 'Total portfolio value — auto-updated from IB positions';
COMMENT ON COLUMN auto_trader_config.base_allocation_pct IS 'Base % of portfolio per long-term position';
COMMENT ON COLUMN auto_trader_config.max_position_pct IS 'Max single-position % of portfolio';
COMMENT ON COLUMN auto_trader_config.risk_per_trade_pct IS 'Max risk % per scanner trade (Kelly-capped)';
COMMENT ON COLUMN auto_trader_config.dip_buy_enabled IS 'Auto average-down on long-term position dips';
COMMENT ON COLUMN auto_trader_config.dip_buy_cooldown_hours IS 'Hours between dip buys for same ticker';
COMMENT ON COLUMN auto_trader_config.profit_take_enabled IS 'Auto trim long-term positions on rallies';
COMMENT ON COLUMN auto_trader_config.min_hold_pct IS 'Never sell below this % of original position';
COMMENT ON COLUMN auto_trader_config.market_regime_enabled IS 'Adjust sizing based on VIX/SPY conditions';
COMMENT ON COLUMN auto_trader_config.max_sector_pct IS 'Max portfolio allocation to one sector';
COMMENT ON COLUMN auto_trader_config.earnings_avoid_enabled IS 'Skip trades near earnings announcements';
COMMENT ON COLUMN auto_trader_config.earnings_blackout_days IS 'Days before earnings to blackout new entries';
COMMENT ON COLUMN auto_trader_config.kelly_adaptive_enabled IS 'Use Half-Kelly from actual trade win rate';
