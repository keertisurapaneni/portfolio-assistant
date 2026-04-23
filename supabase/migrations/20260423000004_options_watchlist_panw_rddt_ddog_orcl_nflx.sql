-- Options Watchlist — add PANW, RDDT, DDOG, ORCL, NFLX
-- All have liquid options chains, elevated IV rank, and strong underlying trends.
INSERT INTO options_watchlist (ticker, added_by, notes) VALUES
  ('PANW', 'manual', 'Palo Alto Networks — cybersecurity leader, liquid chain, high IV rank'),
  ('RDDT', 'manual', 'Reddit — high-growth social platform, elevated IV, smaller cap so use 1 contract max'),
  ('DDOG', 'manual', 'Datadog — cloud monitoring/observability, consistent IV, strong institutional ownership'),
  ('ORCL', 'manual', 'Oracle — enterprise cloud/database, steady IV, liquid chain, dividend cushion'),
  ('NFLX', 'manual', 'Netflix — streaming leader, high premium due to earnings vol, liquid chain')
ON CONFLICT (ticker) DO UPDATE
  SET notes = EXCLUDED.notes
  WHERE options_watchlist.notes IS NULL;
