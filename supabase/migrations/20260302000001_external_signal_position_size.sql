-- Add configurable flat position size for influencer/external strategy signals.
-- When set > 0, this overrides dynamic risk-based sizing for daily signal trades,
-- preventing oversized positions from tight stop losses hitting the hard cap.
ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS external_signal_position_size numeric DEFAULT 5000;

-- Update live config:
-- • external_signal_position_size = $5000 per influencer signal trade (was uncapped, could hit $50k)
-- • max_daily_deployment = $100k (was $50k — allows 10+ signals at $5k each without blocking)
-- • long_term_bucket_pct = 25% (was 40% — frees up $75k more for day/swing allocation)
UPDATE auto_trader_config SET
  external_signal_position_size = 5000,
  max_daily_deployment          = 100000,
  long_term_bucket_pct          = 25
WHERE id = 'default';
