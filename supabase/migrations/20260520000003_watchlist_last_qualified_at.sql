-- Add last_qualified_at to options_watchlist so the scanner can track which
-- tickers are regularly qualifying and surface stale ones for eviction.

ALTER TABLE options_watchlist
  ADD COLUMN IF NOT EXISTS last_qualified_at timestamptz;
