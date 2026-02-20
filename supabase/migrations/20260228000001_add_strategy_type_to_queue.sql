-- Add strategy_type to strategy_video_queue for display after AI classification
ALTER TABLE strategy_video_queue
  ADD COLUMN IF NOT EXISTS strategy_type TEXT;
