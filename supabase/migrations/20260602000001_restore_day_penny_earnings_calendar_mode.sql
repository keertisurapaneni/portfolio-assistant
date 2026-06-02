-- Restore DAY_PENNY and EARNINGS_CALENDAR to paper_trades_mode_check.
-- Migration 20260601000002 dropped both when it added OPTIONS_SCALP.
-- This caused all DAY_PENNY trades (penny influencer videos) to fail with
-- a constraint violation since June 1, 2026.

ALTER TABLE paper_trades DROP CONSTRAINT IF EXISTS paper_trades_mode_check;

ALTER TABLE paper_trades ADD CONSTRAINT paper_trades_mode_check
  CHECK (mode IN (
    'DAY_TRADE',
    'SWING_TRADE',
    'LONG_TERM',
    'DAY_PENNY',
    'OPTIONS_PUT',
    'OPTIONS_CALL',
    'OPTIONS_SCALP',
    'CREDIT_SPREAD',
    'CALENDAR_SPREAD',
    'EARNINGS_CALENDAR'
  ));
