-- Add auto_evaluations to trade_scans
-- Stores auto-trader gate results per ticker so the UI can show
-- "Armed / Watching / Blocked" status on each Trade Idea card.
-- Shape: { [ticker]: { status: string, reason: string, evaluated_at: string } }

ALTER TABLE trade_scans
  ADD COLUMN IF NOT EXISTS auto_evaluations JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN trade_scans.auto_evaluations IS
  'Auto-trader gate results per ticker. Shape: { ticker: { status, reason, evaluated_at } }';
