-- Stores weekly screener suggestions for new options watchlist tickers.
-- The user reviews these and clicks "Add" to promote to the real watchlist.

CREATE TABLE IF NOT EXISTS options_watchlist_candidates (
  ticker          TEXT PRIMARY KEY,
  name            TEXT,
  price           NUMERIC(10,2),
  beta            NUMERIC(5,2),
  market_cap_b    NUMERIC(10,2),
  high_52w        NUMERIC(10,2),
  low_52w         NUMERIC(10,2),
  pct_from_52w_high NUMERIC(6,2),
  tier            TEXT NOT NULL DEFAULT 'GROWTH'
                    CHECK (tier IN ('STABLE', 'GROWTH', 'HIGH_VOL')),
  industry        TEXT,
  reason          TEXT,
  dismissed       BOOLEAN NOT NULL DEFAULT FALSE,
  scanned_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_at        TIMESTAMPTZ
);

COMMENT ON TABLE options_watchlist_candidates IS
  'Weekly screener suggestions — reviewed by user before promoting to options_watchlist';
