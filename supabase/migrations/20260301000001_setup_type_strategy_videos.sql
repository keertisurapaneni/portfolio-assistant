-- Add setup_type to strategy_videos
-- Captures how the influencer intends the trade to be executed:
--   breakout      - enter when price breaks above/below a level with volume
--   momentum      - buy the directional move in the first hour
--   pullback_vwap - wait for a pullback to VWAP or support before entering
--   range         - play support/resistance range, direction unclear until trigger
ALTER TABLE strategy_videos
  ADD COLUMN IF NOT EXISTS setup_type TEXT
    CHECK (setup_type IN ('breakout', 'momentum', 'pullback_vwap', 'range'));
