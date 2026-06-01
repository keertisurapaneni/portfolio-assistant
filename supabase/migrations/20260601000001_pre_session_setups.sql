-- Pre-session ORB setups: generated nightly after market close.
-- Each row is a conditional bracket for the next trading day:
--   BUY if price breaks above trigger_price (prior day high + buffer)
--   SELL if price breaks below trigger_price (prior day low - buffer)
-- Executed at market open only when price confirms AND RVOL >= 1.2x.

CREATE TABLE IF NOT EXISTS pre_session_setups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker          TEXT NOT NULL,
  trade_date      DATE NOT NULL,                   -- the day this setup should execute
  signal          TEXT NOT NULL CHECK (signal IN ('BUY', 'SELL')),
  trigger_price   NUMERIC(12,4) NOT NULL,           -- break above (BUY) or below (SELL)
  stop_loss       NUMERIC(12,4) NOT NULL,
  take_profit1    NUMERIC(12,4) NOT NULL,           -- T1 (1:2 R:R)
  take_profit2    NUMERIC(12,4),                    -- T2 (1:3 R:R)
  prior_day_high  NUMERIC(12,4) NOT NULL,
  prior_day_low   NUMERIC(12,4) NOT NULL,
  prior_day_close NUMERIC(12,4) NOT NULL,
  prior_day_volume BIGINT,
  avg_volume_10d  BIGINT,                           -- 10-day avg volume
  rvol            NUMERIC(6,2),                     -- prior_day_volume / avg_volume_10d
  trend_4h        TEXT,                             -- 'up' | 'down' | 'neutral'
  ema100_4h       NUMERIC(12,4),
  atr             NUMERIC(12,4),                    -- Average True Range (for sizing stops)
  reason          TEXT,                             -- human-readable rationale
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','TRIGGERED','EXPIRED','SKIPPED')),
  triggered_trade_id UUID REFERENCES paper_trades(id),
  triggered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pre_session_setups_date   ON pre_session_setups (trade_date);
CREATE INDEX idx_pre_session_setups_status ON pre_session_setups (status);
CREATE UNIQUE INDEX idx_pre_session_setups_unique
  ON pre_session_setups (ticker, trade_date, signal);

ALTER TABLE pre_session_setups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read pre_session_setups"  ON pre_session_setups FOR SELECT USING (true);
CREATE POLICY "Anyone can insert pre_session_setups" ON pre_session_setups FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update pre_session_setups" ON pre_session_setups FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete pre_session_setups" ON pre_session_setups FOR DELETE USING (true);
