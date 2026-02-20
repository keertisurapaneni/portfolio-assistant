-- Structured performance logging for LONG_TERM trades.
-- Logged when a LONG_TERM position is closed (sync detects position gone).
-- Does not modify trading logic — logging only.

CREATE TABLE performance_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    paper_trade_id UUID REFERENCES paper_trades(id) ON DELETE SET NULL,
    ticker TEXT NOT NULL,
    tag TEXT,                    -- 'Gold Mine' | 'Steady Compounder' (from notes/scanner_reason)
    conviction INT,
    valuation_tag TEXT,          -- 'Deep Value' | 'Undervalued' | etc.
    entry_date TIMESTAMPTZ NOT NULL,
    exit_date TIMESTAMPTZ NOT NULL,
    entry_regime TEXT,           -- 'above_sma200' | 'below_sma200' (SPY vs 200-day at entry)
    position_size NUMERIC,
    return_pct NUMERIC,
    max_drawdown_during_hold NUMERIC,  -- max peak-to-trough decline % during hold
    max_runup_during_hold NUMERIC,     -- max gain % from entry during hold
    days_held NUMERIC,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_performance_log_paper_trade_id ON performance_log (paper_trade_id);
CREATE INDEX idx_performance_log_ticker ON performance_log (ticker);
CREATE INDEX idx_performance_log_tag ON performance_log (tag);
CREATE INDEX idx_performance_log_exit_date ON performance_log (exit_date DESC);

ALTER TABLE performance_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read performance_log" ON performance_log FOR SELECT USING (true);
CREATE POLICY "Anyone can insert performance_log" ON performance_log FOR INSERT WITH CHECK (true);

GRANT SELECT, INSERT ON performance_log TO anon;

COMMENT ON TABLE performance_log IS 'Structured performance logging for closed LONG_TERM trades — tag, conviction, regime, drawdown, runup';
