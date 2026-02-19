-- Enable Realtime for trade_scans so auto-trader can react immediately
-- when the scanner refreshes (e.g. from TradeIdeas UI) instead of waiting
-- for the next scheduler tick.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'trade_scans'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE trade_scans;
  END IF;
END $$;
