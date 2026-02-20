-- Day Trade Validation Log — columns for 10–20 day validation phase.
-- Log: InPlayScore, Pass 1 confidence, Pass 2 confidence, entry trigger, R-multiple, time of entry, market condition.
-- Enables analysis: Are large-cap trend days working? Chop days killing it? Is confidence ≥7 predictive?

ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS in_play_score NUMERIC,
  ADD COLUMN IF NOT EXISTS pass1_confidence INT,
  ADD COLUMN IF NOT EXISTS entry_trigger_type TEXT,
  ADD COLUMN IF NOT EXISTS r_multiple NUMERIC,
  ADD COLUMN IF NOT EXISTS market_condition TEXT;

COMMENT ON COLUMN paper_trades.in_play_score IS 'InPlayScore at scan time (large-cap ranking)';
COMMENT ON COLUMN paper_trades.pass1_confidence IS 'Gemini Pass 1 confidence (indicator-only screen)';
COMMENT ON COLUMN paper_trades.entry_trigger_type IS 'bracket_limit | market | dip_buy | profit_take | manual';
COMMENT ON COLUMN paper_trades.r_multiple IS 'Realized R: (closePrice - entry) / riskPerShare for BUY; (entry - closePrice) / riskPerShare for SELL';
COMMENT ON COLUMN paper_trades.market_condition IS 'trend | chop at entry (from SPY/VIX)';
