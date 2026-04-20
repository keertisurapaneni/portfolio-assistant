-- Options Wheel Engine
-- Extends paper_trades to support options modes and adds an options watchlist.

-- 1. Extend the mode CHECK to include options types
ALTER TABLE paper_trades
  DROP CONSTRAINT IF EXISTS paper_trades_mode_check;

ALTER TABLE paper_trades
  ADD CONSTRAINT paper_trades_mode_check
    CHECK (mode IN ('DAY_TRADE', 'SWING_TRADE', 'LONG_TERM', 'OPTIONS_PUT', 'OPTIONS_CALL'));

-- 2. Options-specific columns on paper_trades
ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS option_strike      NUMERIC,        -- strike price of the option
  ADD COLUMN IF NOT EXISTS option_expiry      DATE,           -- expiration date
  ADD COLUMN IF NOT EXISTS option_premium     NUMERIC,        -- premium collected per share
  ADD COLUMN IF NOT EXISTS option_contracts   INT DEFAULT 1,  -- number of contracts (1 = 100 shares)
  ADD COLUMN IF NOT EXISTS option_delta       NUMERIC,        -- delta at time of entry
  ADD COLUMN IF NOT EXISTS option_iv_rank     NUMERIC,        -- IV rank 0-100 at entry
  ADD COLUMN IF NOT EXISTS option_prob_profit NUMERIC,        -- probability of profit % at entry
  ADD COLUMN IF NOT EXISTS option_net_price   NUMERIC,        -- strike - premium (effective buy price if assigned)
  ADD COLUMN IF NOT EXISTS option_capital_req NUMERIC,        -- strike * 100 * contracts (cash obligation)
  ADD COLUMN IF NOT EXISTS option_annual_yield NUMERIC,       -- annualized yield on capital
  ADD COLUMN IF NOT EXISTS option_assigned    BOOLEAN DEFAULT FALSE,  -- true if put was exercised / call called away
  ADD COLUMN IF NOT EXISTS option_close_pct   NUMERIC;        -- % of max profit captured at close

-- 3. Options watchlist — stocks pre-approved for the wheel strategy
CREATE TABLE IF NOT EXISTS options_watchlist (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker      TEXT NOT NULL UNIQUE,
  added_by    TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'steady_compounders' | 'system'
  min_price   NUMERIC,                        -- skip if stock drops below this
  notes       TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed with a starter watchlist (quality large-caps good for wheel)
INSERT INTO options_watchlist (ticker, added_by, notes) VALUES
  ('AAPL',  'manual', 'Apple — quality compounder, liquid options chain'),
  ('MSFT',  'manual', 'Microsoft — quality compounder, liquid options chain'),
  ('GOOGL', 'manual', 'Alphabet — quality compounder'),
  ('AMZN',  'manual', 'Amazon — quality compounder'),
  ('NVDA',  'manual', 'NVDA — high IV, great premium'),
  ('META',  'manual', 'Meta — high IV, great premium'),
  ('TSLA',  'manual', 'Tesla — high IV, volatile but liquid'),
  ('KO',    'manual', 'Coca-Cola — defensive, good for covered calls'),
  ('JPM',   'manual', 'JPMorgan — financials, steady'),
  ('V',     'manual', 'Visa — quality, steady cash flows'),
  ('MA',    'manual', 'Mastercard — quality, steady cash flows'),
  ('COST',  'manual', 'Costco — quality compounder'),
  ('UNH',   'manual', 'UnitedHealth — defensive healthcare'),
  ('HD',    'manual', 'Home Depot — steady dividend payer'),
  ('PLTR',  'manual', 'Palantir — high IV, momentum name')
ON CONFLICT (ticker) DO NOTHING;

-- 4. Options scan results cache — daily scan output per ticker
CREATE TABLE IF NOT EXISTS options_scan_results (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker          TEXT NOT NULL,
  scan_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  signal          TEXT NOT NULL CHECK (signal IN ('SELL_PUT', 'SELL_CALL', 'NO_SIGNAL')),
  strike          NUMERIC,
  expiry          DATE,
  premium         NUMERIC,
  net_price       NUMERIC,
  delta           NUMERIC,
  iv_rank         NUMERIC,
  prob_profit     NUMERIC,
  capital_req     NUMERIC,
  annual_yield    NUMERIC,
  checks_passed   JSONB,   -- which of the 8 checks passed/failed
  skip_reason     TEXT,    -- why skipped if no signal
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ticker, scan_date, signal)
);

CREATE INDEX IF NOT EXISTS idx_options_scan_date ON options_scan_results (scan_date DESC);
CREATE INDEX IF NOT EXISTS idx_options_scan_ticker ON options_scan_results (ticker);

-- RLS
ALTER TABLE options_watchlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE options_scan_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read options watchlist" ON options_watchlist FOR SELECT USING (true);
CREATE POLICY "Anyone can insert options watchlist" ON options_watchlist FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update options watchlist" ON options_watchlist FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete options watchlist" ON options_watchlist FOR DELETE USING (true);

CREATE POLICY "Anyone can read options scan results" ON options_scan_results FOR SELECT USING (true);
CREATE POLICY "Anyone can insert options scan results" ON options_scan_results FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update options scan results" ON options_scan_results FOR UPDATE USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON options_watchlist TO anon;
GRANT SELECT, INSERT, UPDATE ON options_scan_results TO anon;

COMMENT ON TABLE options_watchlist IS 'Pre-approved stocks for the options wheel strategy';
COMMENT ON TABLE options_scan_results IS 'Daily options scan output — best put/call selling opportunities';
