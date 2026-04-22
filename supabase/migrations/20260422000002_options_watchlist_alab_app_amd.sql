-- Options Watchlist — add ALAB, APP, AMD with descriptions
INSERT INTO options_watchlist (ticker, added_by, notes) VALUES
  ('ALAB', 'manual', 'Astera Labs — semiconductor/data center, high IV'),
  ('APP',  'manual', 'AppLovin — adtech/mobile gaming, elevated IV'),
  ('AMD',  'manual', 'Advanced Micro Devices — semiconductor, high IV, liquid chain')
ON CONFLICT (ticker) DO UPDATE
  SET notes = EXCLUDED.notes
  WHERE options_watchlist.notes IS NULL;
