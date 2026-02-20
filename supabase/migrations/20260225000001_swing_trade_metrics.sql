-- Swing trade diagnostics — daily aggregate metrics (logging only).

CREATE TABLE IF NOT EXISTS swing_trade_metrics (
  date DATE PRIMARY KEY,
  swing_signals INT NOT NULL DEFAULT 0,
  swing_confident INT NOT NULL DEFAULT 0,
  swing_skipped_distance INT NOT NULL DEFAULT 0,
  swing_orders_placed INT NOT NULL DEFAULT 0,
  swing_orders_expired INT NOT NULL DEFAULT 0,
  swing_orders_filled INT NOT NULL DEFAULT 0
);

COMMENT ON TABLE swing_trade_metrics IS 'Daily swing trade funnel: signals → confident → skipped/placed/expired/filled';

-- Atomic upsert for incrementing metrics (call with deltas; omit = 0)
CREATE OR REPLACE FUNCTION upsert_swing_metrics(
  p_date DATE,
  p_swing_signals INT DEFAULT 0,
  p_swing_confident INT DEFAULT 0,
  p_swing_skipped_distance INT DEFAULT 0,
  p_swing_orders_placed INT DEFAULT 0,
  p_swing_orders_expired INT DEFAULT 0,
  p_swing_orders_filled INT DEFAULT 0
) RETURNS void AS $$
BEGIN
  INSERT INTO swing_trade_metrics (date, swing_signals, swing_confident, swing_skipped_distance, swing_orders_placed, swing_orders_expired, swing_orders_filled)
  VALUES (p_date, COALESCE(p_swing_signals, 0), COALESCE(p_swing_confident, 0), COALESCE(p_swing_skipped_distance, 0), COALESCE(p_swing_orders_placed, 0), COALESCE(p_swing_orders_expired, 0), COALESCE(p_swing_orders_filled, 0))
  ON CONFLICT (date) DO UPDATE SET
    swing_signals = swing_trade_metrics.swing_signals + COALESCE(EXCLUDED.swing_signals, 0),
    swing_confident = swing_trade_metrics.swing_confident + COALESCE(EXCLUDED.swing_confident, 0),
    swing_skipped_distance = swing_trade_metrics.swing_skipped_distance + COALESCE(EXCLUDED.swing_skipped_distance, 0),
    swing_orders_placed = swing_trade_metrics.swing_orders_placed + COALESCE(EXCLUDED.swing_orders_placed, 0),
    swing_orders_expired = swing_trade_metrics.swing_orders_expired + COALESCE(EXCLUDED.swing_orders_expired, 0),
    swing_orders_filled = swing_trade_metrics.swing_orders_filled + COALESCE(EXCLUDED.swing_orders_filled, 0);
END;
$$ LANGUAGE plpgsql;

-- RLS: service role bypasses; anon can read for dashboards
ALTER TABLE swing_trade_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anon read" ON swing_trade_metrics FOR SELECT TO anon USING (true);
GRANT SELECT ON swing_trade_metrics TO anon;
