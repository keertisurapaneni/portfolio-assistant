-- Unified trade performance logging for ALL closed trades (DAY_TRADE, SWING_TRADE, LONG_TERM).
-- Logging + analytics only — does not modify trading logic.

CREATE TABLE trade_performance_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trade_id UUID NOT NULL UNIQUE REFERENCES paper_trades(id) ON DELETE CASCADE,
    ticker TEXT NOT NULL,
    strategy TEXT NOT NULL CHECK (strategy IN ('DAY_TRADE', 'SWING_TRADE', 'LONG_TERM')),
    tag TEXT,                    -- 'Steady Compounder' | 'Gold Mine' | null (LONG_TERM only)
    entry_trigger_type TEXT,
    status TEXT NOT NULL DEFAULT 'CLOSED',
    close_reason TEXT,
    entry_datetime TIMESTAMPTZ NOT NULL,
    exit_datetime TIMESTAMPTZ NOT NULL,
    entry_price NUMERIC,
    exit_price NUMERIC,
    qty INT,
    notional_at_entry NUMERIC,
    realized_pnl NUMERIC,
    realized_return_pct NUMERIC,
    days_held NUMERIC,
    max_runup_pct_during_hold NUMERIC,
    max_drawdown_pct_during_hold NUMERIC,
    regime_at_entry JSONB,       -- { spy_above_50, spy_above_200, vix_bucket }
    regime_at_exit JSONB,
    trigger_label TEXT,          -- EOD_CLOSE | IB_POSITION_GONE | EXPIRED_DAY_ORDER | EXPIRED_SWING_BRACKET
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trade_perf_log_ticker ON trade_performance_log (ticker);
CREATE INDEX idx_trade_perf_log_strategy ON trade_performance_log (strategy);
CREATE INDEX idx_trade_perf_log_tag ON trade_performance_log (tag);
CREATE INDEX idx_trade_perf_log_exit_datetime ON trade_performance_log (exit_datetime DESC);

ALTER TABLE trade_performance_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read trade_performance_log" ON trade_performance_log FOR SELECT USING (true);
CREATE POLICY "Anyone can insert trade_performance_log" ON trade_performance_log FOR INSERT WITH CHECK (true);

GRANT SELECT, INSERT ON trade_performance_log TO anon;

COMMENT ON TABLE trade_performance_log IS 'Unified performance logging for all closed trades — DAY_TRADE, SWING_TRADE, LONG_TERM';
