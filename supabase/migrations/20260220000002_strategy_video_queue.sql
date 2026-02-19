-- Strategy Video Queue — URLs pasted from phone (Instagram, Twitter, YouTube)
-- Processed later by ingest_video.py --from-queue
CREATE TABLE strategy_video_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url TEXT NOT NULL,
  platform TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  strategy_video_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX idx_strategy_video_queue_status ON strategy_video_queue(status);

ALTER TABLE strategy_video_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read strategy video queue"
  ON strategy_video_queue FOR SELECT USING (true);

CREATE POLICY "Anyone can insert strategy video queue"
  ON strategy_video_queue FOR INSERT WITH CHECK (true);

CREATE POLICY "Anyone can update strategy video queue"
  ON strategy_video_queue FOR UPDATE USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON strategy_video_queue TO anon;
