-- Expand the paper_trades mode check constraint to include all options strategy modes.
-- OPTIONS_SCALP, OPTIONS_CALL, CREDIT_SPREAD, CALENDAR_SPREAD were missing,
-- causing every scalp/call/spread insert to fail silently since launch.

ALTER TABLE paper_trades DROP CONSTRAINT IF EXISTS paper_trades_mode_check;

ALTER TABLE paper_trades ADD CONSTRAINT paper_trades_mode_check
  CHECK (mode IN (
    'DAY_TRADE',
    'SWING_TRADE',
    'LONG_TERM',
    'OPTIONS_PUT',
    'OPTIONS_CALL',
    'OPTIONS_SCALP',
    'CREDIT_SPREAD',
    'CALENDAR_SPREAD'
  ));
