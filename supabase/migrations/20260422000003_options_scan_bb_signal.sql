-- Bollinger Band timing signal columns on options scan results.
-- bb_lower / bb_upper: the 20-period ±2σ bands at scan time.
-- bb_signal: 'at_lower' = price ≤ lower band (prime entry), 'near_lower' = within 5% above.

ALTER TABLE options_scan_results
  ADD COLUMN IF NOT EXISTS bb_lower   NUMERIC,
  ADD COLUMN IF NOT EXISTS bb_upper   NUMERIC,
  ADD COLUMN IF NOT EXISTS bb_signal  TEXT
    CHECK (bb_signal IN ('at_lower', 'near_lower'));

COMMENT ON COLUMN options_scan_results.bb_lower  IS 'Bollinger Band lower (SMA20 - 2σ) at scan time';
COMMENT ON COLUMN options_scan_results.bb_upper  IS 'Bollinger Band upper (SMA20 + 2σ) at scan time';
COMMENT ON COLUMN options_scan_results.bb_signal IS 'Entry timing: at_lower = price ≤ lower band, near_lower = within 5%';
