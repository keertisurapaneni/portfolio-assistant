-- Strategy-level cold streak state tracking
-- Inspired by James Rich Young's approach: track per-strategy performance
-- and automatically halve position size during cold streaks.

CREATE TABLE IF NOT EXISTS strategy_streak_state (
  mode TEXT PRIMARY KEY,
  is_cold BOOLEAN NOT NULL DEFAULT false,
  entered_cold_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rolling_win_rate NUMERIC,
  window_size INT NOT NULL DEFAULT 10
);

ALTER TABLE strategy_streak_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read strategy_streak_state" ON strategy_streak_state FOR SELECT USING (true);
CREATE POLICY "Anyone can insert strategy_streak_state" ON strategy_streak_state FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update strategy_streak_state" ON strategy_streak_state FOR UPDATE USING (true);

-- Seed rows for active modes
INSERT INTO strategy_streak_state (mode, is_cold, window_size)
VALUES
  ('DAY_TRADE', false, 10),
  ('DAY_PENNY', false, 10),
  ('SWING_TRADE', false, 5)
ON CONFLICT (mode) DO NOTHING;
