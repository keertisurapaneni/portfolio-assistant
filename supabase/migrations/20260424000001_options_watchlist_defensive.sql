-- Options Watchlist — defensive STABLE-tier additions for bear/high-VIX markets
--
-- Rationale: current watchlist is 90% tech (blocked in bear mode).
-- Bear mode only allows Consumer Staples, Utilities, Health Care, Financials.
-- These 14 additions ensure 10-15 qualifying candidates on any given morning scan
-- even when SPY is below SMA200 — exactly when IV is elevated and premium is fat.
--
-- Selection criteria:
--   1. Low beta (<1.2) → scanner won't skip on beta filter
--   2. Liquid options chain (>5k open interest on front-month ATM strikes)
--   3. Business you'd be comfortable owning at a 15-20% discount if assigned
--   4. Sector passes bear mode filter

INSERT INTO options_watchlist (ticker, added_by, notes, tier) VALUES
  -- Health Care (UNH already in watchlist)
  ('JNJ',  'system', 'Johnson & Johnson — blue-chip pharma/medtech, consistently elevated IV rank, comfortable assignment',       'STABLE'),
  ('ABBV', 'system', 'AbbVie — high and persistent IV (ESG exclusions + Humira cliff), dividend cushion if assigned',            'STABLE'),
  ('PFE',  'system', 'Pfizer — low share price ($25-27) = small capital per contract, elevated IV post-COVID reset',             'STABLE'),
  ('MRK',  'system', 'Merck — Keytruda uncertainty drives IV; solid cash flows, quality assignment target',                      'STABLE'),
  ('CVS',  'system', 'CVS Health — defensive healthcare/pharmacy, consistently high IV, inexpensive per contract',               'STABLE'),

  -- Consumer Staples (KO, COST already in watchlist)
  ('PG',   'system', 'Procter & Gamble — ultra-stable consumer staple, elevated IV in macro selloffs, ideal wheel name',         'STABLE'),
  ('WMT',  'system', 'Walmart — defensive retail, elevated IV during tariff/inflation cycles, strong ownership candidate',       'STABLE'),
  ('MO',   'system', 'Altria — very high persistent IV rank (ESG exclusion premium), ~$53 stock, 15-25% annual put yield',       'STABLE'),

  -- Financials (JPM, MA, V already in watchlist)
  ('GS',   'system', 'Goldman Sachs — elevated IV, liquid deep chain, great premium per contract (~$500 stock)',                 'GROWTH'),
  ('BAC',  'system', 'Bank of America — liquid, ~$43 stock (low capital barrier), decent IV in rate/credit cycles',              'STABLE'),
  ('WFC',  'system', 'Wells Fargo — regulatory overhang keeps IV elevated; strong put-selling opportunity on dips',              'STABLE'),
  ('C',    'system', 'Citigroup — cheapest big bank ~$63, best premium-to-capital ratio in financials sector',                   'STABLE'),

  -- Utilities (none in watchlist currently)
  ('NEE',  'system', 'NextEra Energy — largest US utility, IV spikes with rates; passes all bear mode gates, steady underlying', 'STABLE'),
  ('DUK',  'system', 'Duke Energy — regulated utility, low beta, elevated IV during energy/rate selloffs',                       'STABLE')

ON CONFLICT (ticker) DO UPDATE
  SET notes = EXCLUDED.notes,
      tier  = EXCLUDED.tier
  WHERE options_watchlist.added_by = 'system';
