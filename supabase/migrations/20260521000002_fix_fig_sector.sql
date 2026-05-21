-- Fix FIG (Figma) — correct sector and notes
UPDATE options_watchlist
SET
  sector = 'Technology',
  notes  = 'Figma — design software, high-growth tech, elevated IV'
WHERE ticker = 'FIG';
