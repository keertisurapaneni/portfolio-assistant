-- Credit spread support: vertical spreads (bull put / bear call)
-- Adds spread-specific columns to paper_trades for tracking two-leg positions.

ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS spread_type       TEXT,      -- 'BULL_PUT' | 'BEAR_CALL'
  ADD COLUMN IF NOT EXISTS spread_short_strike NUMERIC, -- income leg (sell)
  ADD COLUMN IF NOT EXISTS spread_long_strike  NUMERIC, -- protection leg (buy)
  ADD COLUMN IF NOT EXISTS spread_width      NUMERIC,   -- abs(short - long)
  ADD COLUMN IF NOT EXISTS spread_net_credit NUMERIC,   -- premium collected (per share)
  ADD COLUMN IF NOT EXISTS spread_credit_pct NUMERIC,   -- net_credit / width (0.33 = 33%)
  ADD COLUMN IF NOT EXISTS spread_max_loss   NUMERIC,   -- (width - net_credit) * 100 * contracts
  ADD COLUMN IF NOT EXISTS spread_max_gain   NUMERIC;   -- net_credit * 100 * contracts

-- Drop the old CHECK constraint on mode (if it exists) and add updated one
-- Mode is TEXT without CHECK in production (constraint was dropped in earlier migration)
-- No constraint change needed — CREDIT_SPREAD is just a new string value.

-- Index for spread position queries
CREATE INDEX IF NOT EXISTS idx_paper_trades_spread_type ON paper_trades (spread_type) WHERE spread_type IS NOT NULL;
