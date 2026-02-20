-- Add transcript and ingest progress columns for validation UI
ALTER TABLE strategy_videos
  ADD COLUMN IF NOT EXISTS transcript TEXT,
  ADD COLUMN IF NOT EXISTS ingest_status TEXT DEFAULT 'pending'
    CHECK (ingest_status IN ('pending', 'transcribing', 'done', 'failed')),
  ADD COLUMN IF NOT EXISTS ingest_error TEXT;

CREATE INDEX IF NOT EXISTS idx_strategy_videos_ingest_status
  ON strategy_videos(ingest_status) WHERE ingest_status != 'done';
