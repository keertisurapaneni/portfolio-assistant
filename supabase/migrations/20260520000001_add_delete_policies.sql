-- Add missing DELETE policies and grants for strategy tables.
-- These were omitted in the original migrations, causing frontend deletes to silently fail.

-- strategy_videos
CREATE POLICY "Anyone can delete strategy_videos"
  ON strategy_videos FOR DELETE USING (true);
GRANT DELETE ON strategy_videos TO anon;
GRANT DELETE ON strategy_videos TO service_role;

-- strategy_video_queue
CREATE POLICY "Anyone can delete strategy_video_queue"
  ON strategy_video_queue FOR DELETE USING (true);
GRANT DELETE ON strategy_video_queue TO anon;
GRANT DELETE ON strategy_video_queue TO service_role;

-- external_strategy_signals
CREATE POLICY "Anyone can delete external_strategy_signals"
  ON external_strategy_signals FOR DELETE USING (true);
GRANT DELETE ON external_strategy_signals TO anon;
GRANT DELETE ON external_strategy_signals TO service_role;
