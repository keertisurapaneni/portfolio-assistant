-- External strategy signals + source attribution for performance tracking.
-- Supports page-based/manual ideas (e.g. Instagram pages) with scheduled execution.

-- Track where each trade idea came from.
ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS strategy_source TEXT,
  ADD COLUMN IF NOT EXISTS strategy_source_url TEXT;

ALTER TABLE auto_trade_events
  ADD COLUMN IF NOT EXISTS strategy_source TEXT,
  ADD COLUMN IF NOT EXISTS strategy_source_url TEXT;

CREATE INDEX IF NOT EXISTS idx_paper_trades_strategy_source
  ON paper_trades (strategy_source)
  WHERE strategy_source IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_auto_trade_events_strategy_source
  ON auto_trade_events (strategy_source)
  WHERE strategy_source IS NOT NULL;

-- Extend event source enum-like check for externally supplied signals.
ALTER TABLE auto_trade_events DROP CONSTRAINT IF EXISTS auto_trade_events_source_check;
ALTER TABLE auto_trade_events ADD CONSTRAINT auto_trade_events_source_check
  CHECK (source IN (
    'scanner',
    'suggested_finds',
    'manual',
    'system',
    'dip_buy',
    'profit_take',
    'loss_cut',
    'external_signal'
  ));

-- Queue of externally supplied strategy signals.
CREATE TABLE IF NOT EXISTS external_strategy_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name TEXT NOT NULL,
  source_url TEXT,
  ticker TEXT NOT NULL,
  signal TEXT NOT NULL CHECK (signal IN ('BUY', 'SELL')),
  mode TEXT NOT NULL DEFAULT 'SWING_TRADE'
    CHECK (mode IN ('DAY_TRADE', 'SWING_TRADE', 'LONG_TERM')),
  confidence INT NOT NULL DEFAULT 7 CHECK (confidence BETWEEN 1 AND 10),
  entry_price NUMERIC,
  stop_loss NUMERIC,
  target_price NUMERIC,
  position_size_override NUMERIC,
  execute_on_date DATE NOT NULL,
  execute_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'EXECUTED', 'FAILED', 'SKIPPED', 'EXPIRED', 'CANCELLED')),
  failure_reason TEXT,
  executed_trade_id UUID REFERENCES paper_trades(id) ON DELETE SET NULL,
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_external_strategy_signals_status
  ON external_strategy_signals (status);
CREATE INDEX IF NOT EXISTS idx_external_strategy_signals_execute_date
  ON external_strategy_signals (execute_on_date);
CREATE INDEX IF NOT EXISTS idx_external_strategy_signals_source
  ON external_strategy_signals (source_name);

ALTER TABLE external_strategy_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read external strategy signals"
  ON external_strategy_signals FOR SELECT USING (true);
CREATE POLICY "Anyone can insert external strategy signals"
  ON external_strategy_signals FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update external strategy signals"
  ON external_strategy_signals FOR UPDATE USING (true);

GRANT SELECT, INSERT, UPDATE ON external_strategy_signals TO anon;

COMMENT ON TABLE external_strategy_signals IS
  'Scheduled external trade ideas (source-attributed) for auto-trader execution and per-source performance tracking.';
