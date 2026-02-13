-- Portfolio snapshots — daily record of IB portfolio state for performance tracking.

CREATE TABLE portfolio_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_date DATE NOT NULL,
    account_id TEXT,
    total_value NUMERIC,           -- total portfolio market value
    cash_balance NUMERIC,          -- cash balance
    total_pnl NUMERIC,             -- total unrealized P&L
    positions JSONB,               -- array of { ticker, qty, avgCost, mktPrice, mktValue, unrealizedPnl }
    open_trade_count INT DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (snapshot_date, account_id)  -- one snapshot per account per day
);

CREATE INDEX idx_portfolio_snapshots_date ON portfolio_snapshots (snapshot_date DESC);

-- Enable RLS
ALTER TABLE portfolio_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read portfolio snapshots" ON portfolio_snapshots FOR SELECT USING (true);
CREATE POLICY "Anyone can insert portfolio snapshots" ON portfolio_snapshots FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update portfolio snapshots" ON portfolio_snapshots FOR UPDATE USING (true);

GRANT SELECT, INSERT, UPDATE ON portfolio_snapshots TO anon;

COMMENT ON TABLE portfolio_snapshots IS 'Daily snapshots of IB portfolio positions — tracks portfolio growth over time';
