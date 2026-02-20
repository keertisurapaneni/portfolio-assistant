-- Swing entry log — post-trade metrics for filled swing trades.
-- Collect only; no automated decisions yet.

ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS pct_distance_sma20_at_entry NUMERIC,
  ADD COLUMN IF NOT EXISTS macd_histogram_slope_at_entry TEXT,
  ADD COLUMN IF NOT EXISTS volume_vs_10d_avg_at_entry NUMERIC,
  ADD COLUMN IF NOT EXISTS regime_alignment_at_entry TEXT;

COMMENT ON COLUMN paper_trades.pct_distance_sma20_at_entry IS '% distance from SMA20 at entry: (price - sma20) / sma20 * 100';
COMMENT ON COLUMN paper_trades.macd_histogram_slope_at_entry IS 'MACD histogram slope at entry: increasing | decreasing';
COMMENT ON COLUMN paper_trades.volume_vs_10d_avg_at_entry IS 'Volume on entry day / 10-day avg volume (e.g. 1.5 = 50% above avg)';
COMMENT ON COLUMN paper_trades.regime_alignment_at_entry IS 'SPY vs SMAs at entry: above_both | below_both | mixed';
