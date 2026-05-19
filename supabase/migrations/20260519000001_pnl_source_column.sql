-- Add pnl_source column to track provenance of every P&L number
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS pnl_source TEXT;
-- Values: 'ib_realized', 'ib_fill_calculated', 'quote_fallback', 'estimated', 'legacy', null

-- Backfill existing closed trades
UPDATE paper_trades SET pnl_source = 'legacy'
WHERE status IN ('CLOSED', 'TARGET_HIT', 'STOPPED')
  AND pnl IS NOT NULL
  AND pnl_source IS NULL;

ALTER TABLE live_trades ADD COLUMN IF NOT EXISTS pnl_source TEXT;
UPDATE live_trades SET pnl_source = 'legacy'
WHERE status IN ('CLOSED', 'TARGET_HIT', 'STOPPED')
  AND pnl IS NOT NULL
  AND pnl_source IS NULL;
