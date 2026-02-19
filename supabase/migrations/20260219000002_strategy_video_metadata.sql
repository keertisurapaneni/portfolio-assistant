-- Add video-level attribution fields for strategy source performance.

ALTER TABLE external_strategy_signals
  ADD COLUMN IF NOT EXISTS strategy_video_id TEXT,
  ADD COLUMN IF NOT EXISTS strategy_video_heading TEXT;

ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS strategy_video_id TEXT,
  ADD COLUMN IF NOT EXISTS strategy_video_heading TEXT;

ALTER TABLE auto_trade_events
  ADD COLUMN IF NOT EXISTS strategy_video_id TEXT,
  ADD COLUMN IF NOT EXISTS strategy_video_heading TEXT;

CREATE INDEX IF NOT EXISTS idx_paper_trades_strategy_video_id
  ON paper_trades (strategy_video_id)
  WHERE strategy_video_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_paper_trades_strategy_video_heading
  ON paper_trades (strategy_video_heading)
  WHERE strategy_video_heading IS NOT NULL;
