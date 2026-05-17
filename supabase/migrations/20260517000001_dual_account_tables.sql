-- Dual-Account Architecture — Phase 1: Database Migrations
--
-- Physical table isolation for trade-critical data (live_trades, live_trade_events,
-- live_ib_fills, live_strategy_streak_state) plus discriminator columns on analytics
-- tables (trade_performance_log, portfolio_snapshots) and mode routing config.
--
-- All existing paper-only queries are UNCHANGED — live tables have their own query set.

-- ============================================================================
-- 1. live_trades — identical schema to paper_trades, physically separate
-- ============================================================================

CREATE TABLE live_trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticker TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN (
      'DAY_TRADE', 'SWING_TRADE', 'LONG_TERM',
      'OPTIONS_PUT', 'OPTIONS_CALL',
      'EARNINGS_CALENDAR', 'CALENDAR_SPREAD', 'CREDIT_SPREAD',
      'DAY_PENNY'
    )),
    signal TEXT NOT NULL CHECK (signal IN ('BUY', 'SELL')),
    strategy_source TEXT,
    strategy_source_url TEXT,
    strategy_video_id TEXT,
    strategy_video_heading TEXT,
    scanner_confidence INT,
    fa_confidence INT,
    fa_recommendation TEXT,
    entry_price NUMERIC,
    stop_loss NUMERIC,
    target_price NUMERIC,
    target_price2 NUMERIC,
    risk_reward TEXT,
    quantity INT,
    position_size NUMERIC,
    ib_order_id TEXT,
    ib_parent_order_id TEXT,
    ib_tp_order_id TEXT,
    ib_sl_order_id TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'SUBMITTED', 'FILLED', 'PARTIAL',
                          'STOPPED', 'TARGET_HIT', 'CLOSED', 'CANCELLED', 'REJECTED')),
    fill_price NUMERIC,
    close_price NUMERIC,
    pnl NUMERIC,
    pnl_percent NUMERIC,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    filled_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    close_reason TEXT,
    scanner_reason TEXT,
    fa_rationale JSONB,
    notes TEXT,
    in_play_score NUMERIC,
    pass1_confidence INT,
    entry_trigger_type TEXT,
    r_multiple NUMERIC,
    market_condition TEXT,
    pct_distance_sma20_at_entry NUMERIC,
    macd_histogram_slope_at_entry TEXT,
    volume_vs_10d_avg_at_entry NUMERIC,
    regime_alignment_at_entry TEXT,
    price_peak NUMERIC(12,4),
    price_peak_date DATE,
    missing_since TIMESTAMPTZ,
    -- Options fields
    option_strike NUMERIC,
    option_expiry DATE,
    option_premium NUMERIC,
    option_contracts INT DEFAULT 1,
    option_delta NUMERIC,
    option_iv_rank NUMERIC,
    option_prob_profit NUMERIC,
    option_net_price NUMERIC,
    option_capital_req NUMERIC,
    option_annual_yield NUMERIC,
    option_assigned BOOLEAN DEFAULT FALSE,
    option_close_pct NUMERIC,
    -- Roll tracking
    roll_count INT NOT NULL DEFAULT 0,
    rolled_from_id UUID,
    -- Credit spread fields
    spread_type TEXT,
    spread_short_strike NUMERIC,
    spread_long_strike NUMERIC,
    spread_width NUMERIC,
    spread_net_credit NUMERIC,
    spread_credit_pct NUMERIC,
    spread_max_loss NUMERIC,
    spread_max_gain NUMERIC,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_live_trades_status ON live_trades (status);
CREATE INDEX idx_live_trades_ticker ON live_trades (ticker);
CREATE INDEX idx_live_trades_opened ON live_trades (opened_at DESC);
CREATE INDEX idx_live_trades_strategy_source ON live_trades (strategy_source)
  WHERE strategy_source IS NOT NULL;
CREATE INDEX idx_live_trades_rolled_from ON live_trades (rolled_from_id)
  WHERE rolled_from_id IS NOT NULL;
CREATE INDEX idx_live_trades_spread_type ON live_trades (spread_type)
  WHERE spread_type IS NOT NULL;

ALTER TABLE live_trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read live trades" ON live_trades FOR SELECT USING (true);
CREATE POLICY "Anyone can insert live trades" ON live_trades FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update live trades" ON live_trades FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete live trades" ON live_trades FOR DELETE USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON live_trades TO anon;

-- ============================================================================
-- 2. live_trade_events — identical schema to auto_trade_events
-- ============================================================================

CREATE TABLE live_trade_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticker TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('info', 'success', 'warning', 'error')),
    action TEXT,
    source TEXT,
    mode TEXT,
    message TEXT NOT NULL,
    scanner_signal TEXT,
    scanner_confidence INT,
    fa_recommendation TEXT,
    fa_confidence INT,
    skip_reason TEXT,
    strategy_source TEXT,
    strategy_source_url TEXT,
    strategy_video_id TEXT,
    strategy_video_heading TEXT,
    metadata JSONB,
    candle_patterns TEXT[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_live_trade_events_created ON live_trade_events (created_at DESC);
CREATE INDEX idx_live_trade_events_ticker ON live_trade_events (ticker);
CREATE INDEX idx_live_trade_events_action ON live_trade_events (action);

ALTER TABLE live_trade_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read live trade events" ON live_trade_events FOR SELECT USING (true);
CREATE POLICY "Anyone can insert live trade events" ON live_trade_events FOR INSERT WITH CHECK (true);

GRANT SELECT, INSERT ON live_trade_events TO anon;

-- ============================================================================
-- 3. live_ib_fills — identical schema to ib_fills
-- ============================================================================

CREATE TABLE live_ib_fills (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id integer NOT NULL,
  exec_id text,
  ticker text NOT NULL,
  side text NOT NULL,
  quantity numeric NOT NULL,
  fill_price numeric NOT NULL,
  commission numeric,
  realized_pnl numeric,
  filled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE live_ib_fills ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read_live_ib_fills" ON live_ib_fills FOR SELECT USING (true);
CREATE POLICY "insert_live_ib_fills" ON live_ib_fills FOR INSERT WITH CHECK (true);
CREATE POLICY "update_live_ib_fills" ON live_ib_fills FOR UPDATE USING (true);

CREATE INDEX idx_live_ib_fills_order_id ON live_ib_fills(order_id);
CREATE INDEX idx_live_ib_fills_ticker_filled ON live_ib_fills(ticker, filled_at);

-- ============================================================================
-- 4. live_strategy_streak_state — identical schema to strategy_streak_state
-- ============================================================================

CREATE TABLE IF NOT EXISTS live_strategy_streak_state (
  mode TEXT PRIMARY KEY,
  is_cold BOOLEAN NOT NULL DEFAULT false,
  entered_cold_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rolling_win_rate NUMERIC,
  window_size INT NOT NULL DEFAULT 10
);

ALTER TABLE live_strategy_streak_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read live_strategy_streak_state" ON live_strategy_streak_state FOR SELECT USING (true);
CREATE POLICY "Anyone can insert live_strategy_streak_state" ON live_strategy_streak_state FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update live_strategy_streak_state" ON live_strategy_streak_state FOR UPDATE USING (true);

-- Seed DAY_TRADE initially (all modes start on paper, but seed this for when routing is enabled)
INSERT INTO live_strategy_streak_state (mode, is_cold, window_size)
VALUES ('DAY_TRADE', false, 10)
ON CONFLICT (mode) DO NOTHING;

-- ============================================================================
-- 5. Analytics tables — add account_type discriminator
-- ============================================================================

-- trade_performance_log: add account_type (all existing rows are paper)
ALTER TABLE trade_performance_log
  ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'paper'
    CHECK (account_type IN ('paper', 'live'));

CREATE INDEX IF NOT EXISTS idx_trade_perf_log_account_type
  ON trade_performance_log (account_type);

-- Drop FK so trade_performance_log.trade_id can reference both paper_trades and live_trades
ALTER TABLE trade_performance_log DROP CONSTRAINT IF EXISTS trade_performance_log_trade_id_fkey;

-- portfolio_snapshots: add account_type (all existing rows are paper)
ALTER TABLE portfolio_snapshots
  ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'paper'
    CHECK (account_type IN ('paper', 'live'));

-- Update the unique constraint to include account_type
ALTER TABLE portfolio_snapshots
  DROP CONSTRAINT IF EXISTS portfolio_snapshots_snapshot_date_account_id_key;

ALTER TABLE portfolio_snapshots
  ADD CONSTRAINT portfolio_snapshots_snapshot_date_account_id_account_type_key
    UNIQUE (snapshot_date, account_id, account_type);

CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_account_type
  ON portfolio_snapshots (account_type);

-- ============================================================================
-- 6. auto_trader_config — mode routing + live account config
-- ============================================================================

-- Mode routing: maps TradeMode → account_type ('paper' | 'live')
-- IMPORTANT: All modes default to 'paper' for safety — no live trading until
-- explicitly enabled by the operator.
ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS mode_routing JSONB NOT NULL DEFAULT '{
    "DAY_TRADE": "paper",
    "SWING_TRADE": "paper",
    "OPTIONS_PUT": "paper",
    "OPTIONS_CALL": "paper",
    "CALENDAR_SPREAD": "paper",
    "CREDIT_SPREAD": "paper",
    "DAY_PENNY": "paper",
    "LONG_TERM": "paper",
    "EARNINGS_CALENDAR": "paper"
  }'::jsonb;

-- Global kill switch: defaults to TRUE (live trading disabled until explicitly enabled)
ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS live_kill_switch BOOLEAN NOT NULL DEFAULT true;

-- Hard daily loss limit for live account (dollars)
ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS live_daily_loss_limit NUMERIC NOT NULL DEFAULT -500;

-- Live account portfolio value (separate from paper portfolioValue)
ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS live_portfolio_value NUMERIC NOT NULL DEFAULT 100000;

-- Live account position sizing overrides (conservative)
ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS live_position_size NUMERIC NOT NULL DEFAULT 500;

ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS live_max_positions INT NOT NULL DEFAULT 2;

ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS live_max_daily_deployment NUMERIC NOT NULL DEFAULT 5000;
