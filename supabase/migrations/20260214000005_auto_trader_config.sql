-- Auto-trader configuration — persisted in DB instead of localStorage.
-- Single row per user (for now, single-user: id = 'default').

CREATE TABLE auto_trader_config (
    id TEXT PRIMARY KEY DEFAULT 'default',
    enabled BOOLEAN NOT NULL DEFAULT false,
    position_size NUMERIC NOT NULL DEFAULT 1000,
    min_scanner_confidence INT NOT NULL DEFAULT 7,
    min_fa_confidence INT NOT NULL DEFAULT 7,
    min_suggested_finds_conviction INT NOT NULL DEFAULT 8,
    account_id TEXT,
    day_trade_auto_close BOOLEAN NOT NULL DEFAULT true,
    max_positions INT NOT NULL DEFAULT 5,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed with defaults
INSERT INTO auto_trader_config (id) VALUES ('default');

-- Enable RLS
ALTER TABLE auto_trader_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read auto trader config" ON auto_trader_config FOR SELECT USING (true);
CREATE POLICY "Anyone can update auto trader config" ON auto_trader_config FOR UPDATE USING (true);
CREATE POLICY "Anyone can insert auto trader config" ON auto_trader_config FOR INSERT WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON auto_trader_config TO anon;

COMMENT ON TABLE auto_trader_config IS 'Auto-trader settings — persisted across sessions and deployments';
