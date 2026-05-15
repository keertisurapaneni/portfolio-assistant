-- Add DAY_PENNY mode for the penny stock momentum scanner.
-- Follows Ross Cameron's mechanical rules: $2-$20 price, float <10M,
-- 25%+ daily gain, 5x relative volume, news catalyst.
-- Separate pipeline from large-cap day trades with its own P&L tracking.

-- 1. paper_trades: drop and re-add with DAY_PENNY
ALTER TABLE paper_trades
  DROP CONSTRAINT IF EXISTS paper_trades_mode_check;

ALTER TABLE paper_trades
  ADD CONSTRAINT paper_trades_mode_check
    CHECK (mode IN (
      'DAY_TRADE', 'SWING_TRADE', 'LONG_TERM',
      'OPTIONS_PUT', 'OPTIONS_CALL',
      'EARNINGS_CALENDAR', 'CALENDAR_SPREAD', 'CREDIT_SPREAD',
      'DAY_PENNY'
    ));

-- 2. auto_trade_events: drop entirely (app code is the authority)
--    Follows precedent of 20260514000001 which dropped action/source checks.
ALTER TABLE auto_trade_events
  DROP CONSTRAINT IF EXISTS auto_trade_events_mode_check;

-- 3. trade_performance_log: extend strategy CHECK to include DAY_PENNY
ALTER TABLE trade_performance_log
  DROP CONSTRAINT IF EXISTS trade_performance_log_strategy_check;

ALTER TABLE trade_performance_log
  ADD CONSTRAINT trade_performance_log_strategy_check
    CHECK (strategy IN ('DAY_TRADE', 'SWING_TRADE', 'LONG_TERM', 'DAY_PENNY'));

-- 4. Seed penny_trades row in trade_scans (for scanner cache + UI)
INSERT INTO trade_scans (id, data, scanned_at, expires_at)
VALUES (
  'penny_trades',
  '[]'::jsonb,
  NOW(),
  NOW() + INTERVAL '30 minutes'
)
ON CONFLICT (id) DO NOTHING;
