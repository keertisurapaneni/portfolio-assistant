-- Options Watchlist — backfill notes for tickers added without descriptions
-- Inserts new tickers if missing; updates notes only where the field is NULL
-- so existing hand-crafted notes are never overwritten.

INSERT INTO options_watchlist (ticker, added_by, notes) VALUES
  ('SNOW',  'manual', 'Snowflake — high IV cloud data stock, good premium'),
  ('NOW',   'manual', 'ServiceNow — enterprise SaaS, elevated IV, steady'),
  ('CRDO',  'manual', 'Credo Technology — high IV, semiconductor growth play'),
  ('AVGO',  'manual', 'Broadcom — high IV, large semiconductor, solid premium')
ON CONFLICT (ticker) DO UPDATE
  SET notes = EXCLUDED.notes
  WHERE options_watchlist.notes IS NULL;
