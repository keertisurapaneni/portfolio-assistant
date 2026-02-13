-- Auto Trade Events — persists every auto-trader decision for analysis.
-- Captures executions, skips, failures, and the reasons behind each.

CREATE TABLE auto_trade_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticker TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('info', 'success', 'warning', 'error')),
    action TEXT CHECK (action IN ('executed', 'skipped', 'failed')),
    source TEXT CHECK (source IN ('scanner', 'suggested_finds', 'manual', 'system')),
    mode TEXT CHECK (mode IN ('DAY_TRADE', 'SWING_TRADE')),
    message TEXT NOT NULL,
    scanner_signal TEXT,                -- BUY/SELL from scanner
    scanner_confidence INT,
    fa_recommendation TEXT,             -- BUY/SELL/HOLD from full analysis
    fa_confidence INT,
    skip_reason TEXT,                   -- structured reason for skips
    metadata JSONB,                     -- any extra context (valuation tag, conviction, etc.)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for analysis queries
CREATE INDEX idx_auto_trade_events_created ON auto_trade_events (created_at DESC);
CREATE INDEX idx_auto_trade_events_ticker ON auto_trade_events (ticker);
CREATE INDEX idx_auto_trade_events_action ON auto_trade_events (action);
CREATE INDEX idx_auto_trade_events_source ON auto_trade_events (source);

-- Enable RLS
ALTER TABLE auto_trade_events ENABLE ROW LEVEL SECURITY;

-- Public access (single-user paper trading)
CREATE POLICY "Anyone can read auto trade events" ON auto_trade_events FOR SELECT USING (true);
CREATE POLICY "Anyone can insert auto trade events" ON auto_trade_events FOR INSERT WITH CHECK (true);

-- Grant access
GRANT SELECT, INSERT ON auto_trade_events TO anon;

COMMENT ON TABLE auto_trade_events IS 'Persisted log of every auto-trader decision — executions, skips, failures with full context for pattern analysis';
