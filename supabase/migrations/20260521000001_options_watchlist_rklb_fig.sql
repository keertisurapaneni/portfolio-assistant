-- Options Watchlist — add RKLB, FIG
-- NVDA, MSFT, META, RDDT were already present from prior migrations.
INSERT INTO options_watchlist (ticker, added_by, notes, tier, sector) VALUES
  ('RKLB', 'user', 'Rocket Lab — space launch & satellites, high-beta momentum, elevated IV',  'HIGH_VOL', 'Aerospace & Defense'),
  ('FIG',  'user', 'Figs — added to options watchlist by user',                                'HIGH_VOL', 'Consumer Discretionary')
ON CONFLICT (ticker) DO NOTHING;
