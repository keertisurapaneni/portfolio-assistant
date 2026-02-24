-- Add long_term_bucket_pct to auto_trader_config
-- Controls the % of maxTotalAllocation reserved for long-term positions.
-- Day/swing trades (scanner + influencer) are capped at (100 - long_term_bucket_pct)%.
ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS long_term_bucket_pct numeric DEFAULT 40;
