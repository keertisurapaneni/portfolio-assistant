-- Daily Suggestions Cache
-- Stores Suggested Finds results once per day, shared across all users
-- First visitor generates, everyone else reads from cache

CREATE TABLE daily_suggestions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    suggestion_date DATE NOT NULL UNIQUE,
    data JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for fast date lookups
CREATE INDEX idx_daily_suggestions_date ON daily_suggestions(suggestion_date);

-- Enable RLS
ALTER TABLE daily_suggestions ENABLE ROW LEVEL SECURITY;

-- All authenticated users (and anon) can read
CREATE POLICY "Anyone can read daily suggestions"
    ON daily_suggestions
    FOR SELECT
    USING (true);

-- Only service role can write (Edge Functions)
CREATE POLICY "Service role can manage suggestions"
    ON daily_suggestions
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Allow anon to read too (no auth required for suggestions)
GRANT SELECT ON daily_suggestions TO anon;

COMMENT ON TABLE daily_suggestions IS 'Server-side daily cache for AI Suggested Finds — same results for all users each day';
