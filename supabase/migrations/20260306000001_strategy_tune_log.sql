-- strategy_tune_log: records every auto-tune run, what was analyzed, and what was changed.
-- The auto-tune engine runs after market close daily and adjusts auto_trader_config
-- based on rolling 30-day performance per category and strategy source.

CREATE TABLE IF NOT EXISTS strategy_tune_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at        timestamptz NOT NULL DEFAULT now(),
  trigger       text NOT NULL DEFAULT 'scheduled',  -- 'scheduled' | 'manual'
  analysis      jsonb NOT NULL DEFAULT '{}',        -- full performance snapshot used for decisions
  decisions     jsonb NOT NULL DEFAULT '[]',        -- array of {param, old_value, new_value, reason}
  applied       boolean NOT NULL DEFAULT true,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Index for recent log queries
CREATE INDEX IF NOT EXISTS strategy_tune_log_run_at_idx ON strategy_tune_log (run_at DESC);

-- Only keep last 90 days of logs (prevent unbounded growth)
COMMENT ON TABLE strategy_tune_log IS
  'Auto-tune engine run history. Each row = one daily tuning pass. Decisions are bounded to prevent runaway config changes.';
