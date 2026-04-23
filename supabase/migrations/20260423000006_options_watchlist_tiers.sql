-- Add tier column to options_watchlist for per-tier scanner thresholds.
-- STABLE  = dividend / blue-chip (JPM, KO, HD, COST, MA, V, UNH, AAPL, GOOGL, MSFT, AMZN, ORCL)
-- GROWTH  = large-cap tech / quality growth (META, NVDA, AVGO, NOW, SNOW, PANW, DDOG)
-- HIGH_VOL = high-beta / momentum / leveraged (AMD, TSLA, PLTR, APP, ALAB, CRDO, RDDT, NFLX, SOXL, TQQQ, NVDL, TSLL)

ALTER TABLE options_watchlist
  ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'GROWTH'
    CHECK (tier IN ('STABLE', 'GROWTH', 'HIGH_VOL'));

COMMENT ON COLUMN options_watchlist.tier IS
  'STABLE=blue-chip/dividend, GROWTH=quality tech, HIGH_VOL=high-beta/momentum/leveraged';

-- Assign tiers
UPDATE options_watchlist SET tier = 'STABLE'   WHERE ticker IN ('JPM','KO','HD','COST','MA','V','UNH','AAPL','GOOGL','MSFT','AMZN','ORCL');
UPDATE options_watchlist SET tier = 'GROWTH'   WHERE ticker IN ('META','NVDA','AVGO','NOW','SNOW','PANW','DDOG','NFLX');
UPDATE options_watchlist SET tier = 'HIGH_VOL' WHERE ticker IN ('AMD','TSLA','PLTR','APP','ALAB','CRDO','RDDT','SOXL','TQQQ','NVDL','TSLL');
