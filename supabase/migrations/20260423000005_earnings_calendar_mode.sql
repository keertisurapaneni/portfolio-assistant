-- Add EARNINGS_CALENDAR mode for the earnings IV-crush calendar spread strategy.
-- This is a separate, non-directional strategy that runs alongside the options wheel:
--   - Entry: 2:30 PM ET, day before earnings (or same day for BMO reporters)
--   - Structure: long calendar spread (sell front-month ATM, buy back-month ATM)
--   - Exit: 9:45 AM ET, next market day (IV crush realised after announcement)
--   - Max loss: debit paid (defined risk, unlike short straddles)

ALTER TABLE paper_trades
  DROP CONSTRAINT IF EXISTS paper_trades_mode_check;

ALTER TABLE paper_trades
  ADD CONSTRAINT paper_trades_mode_check
    CHECK (mode IN (
      'DAY_TRADE', 'SWING_TRADE', 'LONG_TERM',
      'OPTIONS_PUT', 'OPTIONS_CALL',
      'EARNINGS_CALENDAR'
    ));
