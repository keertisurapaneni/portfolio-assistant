-- IV history table for computing IV Rank over time.
-- Scanner writes one row per ticker per day; rank computed from 52-week window.

CREATE TABLE IF NOT EXISTS options_iv_history (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker  TEXT NOT NULL,
  date    DATE NOT NULL DEFAULT CURRENT_DATE,
  iv      NUMERIC NOT NULL,  -- implied volatility as percentage e.g. 35.5
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ticker, date)
);

CREATE INDEX IF NOT EXISTS idx_options_iv_ticker_date ON options_iv_history (ticker, date DESC);

ALTER TABLE options_iv_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read iv history" ON options_iv_history FOR SELECT USING (true);
CREATE POLICY "Anyone can insert iv history" ON options_iv_history FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update iv history" ON options_iv_history FOR UPDATE USING (true);
GRANT SELECT, INSERT, UPDATE ON options_iv_history TO anon;
