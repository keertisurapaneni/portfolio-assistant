-- Add daily_penny as a strategy_type for penny stock watchlist videos
-- (e.g. Ross Cameron / Warrior Trading daily watchlist recaps).
-- Also extend external_strategy_signals.mode to accept DAY_PENNY so
-- penny watchlist signals can flow through the same import pipeline.

-- 1. strategy_videos: extend strategy_type CHECK
ALTER TABLE strategy_videos
  DROP CONSTRAINT IF EXISTS strategy_videos_strategy_type_check;

ALTER TABLE strategy_videos
  ADD CONSTRAINT strategy_videos_strategy_type_check
    CHECK (strategy_type IN ('daily_signal', 'generic_strategy', 'daily_penny'));

-- 2. external_strategy_signals: extend mode CHECK to include DAY_PENNY
ALTER TABLE external_strategy_signals
  DROP CONSTRAINT IF EXISTS external_strategy_signals_mode_check;

ALTER TABLE external_strategy_signals
  ADD CONSTRAINT external_strategy_signals_mode_check
    CHECK (mode IN ('DAY_TRADE', 'SWING_TRADE', 'LONG_TERM', 'DAY_PENNY'));
