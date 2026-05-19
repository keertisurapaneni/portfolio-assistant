-- Extend external_strategy_signals.mode CHECK to include OPTIONS_CALL and OPTIONS_PUT.
-- Previously only DAY_TRADE, SWING_TRADE, LONG_TERM, DAY_PENNY were allowed,
-- which caused options_signal videos to be misrouted as DAY_TRADE.

ALTER TABLE external_strategy_signals
  DROP CONSTRAINT IF EXISTS external_strategy_signals_mode_check;

ALTER TABLE external_strategy_signals
  ADD CONSTRAINT external_strategy_signals_mode_check
    CHECK (mode IN ('DAY_TRADE', 'SWING_TRADE', 'LONG_TERM', 'DAY_PENNY', 'OPTIONS_CALL', 'OPTIONS_PUT'));
