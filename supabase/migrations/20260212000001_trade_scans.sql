-- Trade Scans Cache
-- Stores AI-evaluated trade suggestions (day + swing), shared across all users.
-- Day trades refresh every 30 min during market hours (~13/day).
-- Swing trades refresh 2x/day (open + near close).
-- Edge function checks staleness and only re-scans when needed.

CREATE TABLE trade_scans (
    id TEXT PRIMARY KEY,               -- 'day_trades' or 'swing_trades'
    data JSONB NOT NULL DEFAULT '[]',  -- array of TradeIdea objects
    scanned_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Seed both rows so we can always UPSERT
INSERT INTO trade_scans (id, data, scanned_at, expires_at)
VALUES
    ('day_trades',   '[]', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day'),
    ('swing_trades', '[]', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day');

-- Enable RLS
ALTER TABLE trade_scans ENABLE ROW LEVEL SECURITY;

-- Anyone can read (no auth needed for shared suggestions)
CREATE POLICY "Anyone can read trade scans"
    ON trade_scans FOR SELECT USING (true);

-- Only service role (Edge Functions) can write
CREATE POLICY "Service role can manage trade scans"
    ON trade_scans FOR ALL TO service_role
    USING (true) WITH CHECK (true);

GRANT SELECT ON trade_scans TO anon;

COMMENT ON TABLE trade_scans IS 'Shared AI trade suggestions cache — day trades (30min TTL) and swing trades (6hr TTL)';
