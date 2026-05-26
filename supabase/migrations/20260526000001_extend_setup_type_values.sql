-- Extend setup_type check constraint to include newer setup types:
--   pocket_pivot     - daily chart consolidation pocket breakout (options signal style)
--   bullish_engulfing - bullish engulfing candle reversal pattern on daily chart
--   volume_breakout  - already broke out on above-average volume, continuation expected
ALTER TABLE strategy_videos DROP CONSTRAINT IF EXISTS strategy_videos_setup_type_check;
ALTER TABLE strategy_videos ADD CONSTRAINT strategy_videos_setup_type_check
  CHECK (setup_type IN ('breakout', 'momentum', 'pullback_vwap', 'range', 'pocket_pivot', 'bullish_engulfing', 'volume_breakout'));
