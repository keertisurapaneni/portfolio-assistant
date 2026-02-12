-- Paper Trades — tracks auto-executed trades on IB paper account.
-- Used for backtesting AI signal quality and self-improvement feedback loop.

CREATE TABLE paper_trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticker TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('DAY_TRADE', 'SWING_TRADE')),
    signal TEXT NOT NULL CHECK (signal IN ('BUY', 'SELL')),
    scanner_confidence INT,
    fa_confidence INT,
    fa_recommendation TEXT,        -- BUY/SELL/HOLD from full analysis
    entry_price NUMERIC,
    stop_loss NUMERIC,
    target_price NUMERIC,
    target_price2 NUMERIC,         -- stretch target
    risk_reward TEXT,               -- e.g. "1:2.5"
    quantity INT,
    position_size NUMERIC,         -- $ value of position
    ib_order_id TEXT,
    ib_parent_order_id TEXT,       -- bracket parent
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'SUBMITTED', 'FILLED', 'PARTIAL', 'STOPPED', 'TARGET_HIT', 'CLOSED', 'CANCELLED', 'REJECTED')),
    fill_price NUMERIC,            -- actual fill price
    close_price NUMERIC,           -- actual close price
    pnl NUMERIC,                   -- realized P&L
    pnl_percent NUMERIC,           -- realized P&L %
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    filled_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    close_reason TEXT,             -- 'stop_loss', 'target_hit', 'eod_close', 'manual', 'cancelled'
    scanner_reason TEXT,           -- AI reason from scanner
    fa_rationale JSONB,            -- { technical, sentiment, risk } from FA
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_paper_trades_status ON paper_trades (status);
CREATE INDEX idx_paper_trades_ticker ON paper_trades (ticker);
CREATE INDEX idx_paper_trades_opened ON paper_trades (opened_at DESC);

-- AI feedback: trade outcome analysis stored per-trade
CREATE TABLE trade_learnings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trade_id UUID NOT NULL REFERENCES paper_trades(id) ON DELETE CASCADE,
    outcome TEXT NOT NULL CHECK (outcome IN ('WIN', 'LOSS', 'BREAKEVEN', 'PENDING')),
    lesson TEXT,                    -- AI-generated lesson from this trade
    what_worked TEXT,               -- what indicators/signals were correct
    what_failed TEXT,               -- what indicators/signals were wrong
    market_context TEXT,            -- market conditions during trade
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trade_learnings_outcome ON trade_learnings (outcome);

-- AI performance summary (updated periodically)
CREATE TABLE trade_performance (
    id TEXT PRIMARY KEY DEFAULT 'global',  -- single row for now
    total_trades INT DEFAULT 0,
    wins INT DEFAULT 0,
    losses INT DEFAULT 0,
    breakevens INT DEFAULT 0,
    win_rate NUMERIC DEFAULT 0,
    avg_pnl NUMERIC DEFAULT 0,
    avg_win NUMERIC DEFAULT 0,
    avg_loss NUMERIC DEFAULT 0,
    total_pnl NUMERIC DEFAULT 0,
    best_trade_pnl NUMERIC DEFAULT 0,
    worst_trade_pnl NUMERIC DEFAULT 0,
    common_win_patterns TEXT[],     -- patterns that tend to win
    common_loss_patterns TEXT[],    -- patterns that tend to lose
    ai_summary TEXT,                -- AI-generated performance summary
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed performance row
INSERT INTO trade_performance (id) VALUES ('global');

-- Enable RLS
ALTER TABLE paper_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_learnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_performance ENABLE ROW LEVEL SECURITY;

-- Public read for all (single-user paper trading)
CREATE POLICY "Anyone can read paper trades" ON paper_trades FOR SELECT USING (true);
CREATE POLICY "Anyone can insert paper trades" ON paper_trades FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update paper trades" ON paper_trades FOR UPDATE USING (true);

CREATE POLICY "Anyone can read trade learnings" ON trade_learnings FOR SELECT USING (true);
CREATE POLICY "Anyone can insert trade learnings" ON trade_learnings FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update trade learnings" ON trade_learnings FOR UPDATE USING (true);

CREATE POLICY "Anyone can read trade performance" ON trade_performance FOR SELECT USING (true);
CREATE POLICY "Anyone can update trade performance" ON trade_performance FOR UPDATE USING (true);

-- Grant access
GRANT SELECT, INSERT, UPDATE ON paper_trades TO anon;
GRANT SELECT, INSERT, UPDATE ON trade_learnings TO anon;
GRANT SELECT, UPDATE ON trade_performance TO anon;

COMMENT ON TABLE paper_trades IS 'Auto-executed paper trades from AI scanner signals — tracks entry, exit, P&L';
COMMENT ON TABLE trade_learnings IS 'AI-generated lessons from each completed trade — feeds back into future signals';
COMMENT ON TABLE trade_performance IS 'Aggregate performance stats for AI trading — win rate, P&L, patterns';
