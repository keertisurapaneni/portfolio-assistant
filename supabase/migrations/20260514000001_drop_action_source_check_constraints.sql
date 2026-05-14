-- Drop overly restrictive CHECK constraints on auto_trade_events.
-- The allowed values keep growing (closed, health_check, proceeding,
-- lt_auto_sell, compounder_health, capital_pressure, swing_expiry,
-- scheduler, options, spx_level_scanner …) and the app code is the
-- real authority.  A tight DB enum just causes silent failures —
-- see the CSCO/AMAT reconciliation-loop bug on 2026-05-14.

ALTER TABLE auto_trade_events DROP CONSTRAINT IF EXISTS auto_trade_events_action_check;
ALTER TABLE auto_trade_events DROP CONSTRAINT IF EXISTS auto_trade_events_source_check;
