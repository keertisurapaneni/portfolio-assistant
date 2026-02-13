-- Add LONG_TERM to the mode CHECK constraint on paper_trades and auto_trade_events.
-- Also backfill existing suggested_finds rows to LONG_TERM.

-- paper_trades: drop the inline check and re-add with LONG_TERM
ALTER TABLE paper_trades DROP CONSTRAINT IF EXISTS paper_trades_mode_check;
ALTER TABLE paper_trades ADD CONSTRAINT paper_trades_mode_check CHECK (mode IN ('DAY_TRADE', 'SWING_TRADE', 'LONG_TERM'));

-- auto_trade_events: drop the inline check and re-add with LONG_TERM
ALTER TABLE auto_trade_events DROP CONSTRAINT IF EXISTS auto_trade_events_mode_check;
ALTER TABLE auto_trade_events ADD CONSTRAINT auto_trade_events_mode_check CHECK (mode IN ('DAY_TRADE', 'SWING_TRADE', 'LONG_TERM'));

-- Backfill existing suggested_finds trades to LONG_TERM
UPDATE paper_trades SET mode = 'LONG_TERM' WHERE notes LIKE '%Long-term hold%' AND mode = 'SWING_TRADE';
UPDATE auto_trade_events SET mode = 'LONG_TERM' WHERE source = 'suggested_finds' AND mode = 'SWING_TRADE';
