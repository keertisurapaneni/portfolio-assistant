-- strategy_gates: direction-level hard blocks when a signal type has proven no edge.
-- Complements strategy_streak_state (mode-level 0.5× soft reduction) by adding
-- a SELL-vs-BUY distinction — so SWING SELL can be blocked while SWING BUY continues.
--
-- Populated automatically by evaluateAndGateStrategies() in feedback.ts.
-- Can also be manually seeded (e.g. to immediately block a known-bad signal).

CREATE TABLE IF NOT EXISTS strategy_gates (
  mode            TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('BUY', 'SELL', 'BOTH')),
  blocked         BOOLEAN NOT NULL DEFAULT FALSE,
  win_rate        NUMERIC(5,4),           -- rolling win rate when gate was set
  sample_size     INTEGER,                -- number of trades used to compute win_rate
  blocked_at      TIMESTAMPTZ,
  auto_unblock_at TIMESTAMPTZ,            -- NULL = manual unblock only
  reason          TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (mode, direction)
);

ALTER TABLE strategy_gates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read strategy_gates"  ON strategy_gates FOR SELECT USING (true);
CREATE POLICY "Anyone can insert strategy_gates" ON strategy_gates FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update strategy_gates" ON strategy_gates FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete strategy_gates" ON strategy_gates FOR DELETE USING (true);

-- Seed: immediately block SWING_TRADE SELL — 14% win rate over last 7+ trades.
-- auto_unblock_at = NULL: requires manual review before re-enabling.
INSERT INTO strategy_gates (mode, direction, blocked, win_rate, sample_size, blocked_at, auto_unblock_at, reason)
VALUES (
  'SWING_TRADE', 'SELL', TRUE, 0.14, 7,
  NOW(),
  NULL,
  'Auto-seeded: 14% win rate (1W/7L) — overnight shorts consistently stopped out at market open. Review before re-enabling.'
)
ON CONFLICT (mode, direction) DO UPDATE SET
  blocked = EXCLUDED.blocked,
  win_rate = EXCLUDED.win_rate,
  sample_size = EXCLUDED.sample_size,
  blocked_at = EXCLUDED.blocked_at,
  reason = EXCLUDED.reason,
  updated_at = NOW();
