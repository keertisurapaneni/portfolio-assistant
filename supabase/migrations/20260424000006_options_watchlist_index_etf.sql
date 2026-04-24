-- Migration: Add is_index_etf flag + defensive index ETFs to options_watchlist
--
-- Rationale (party mode decision 2026-04-24):
--   VPU/VYM/VIG are ideal STABLE-tier wheel candidates — low beta (~0.5-0.85),
--   naturally range-bound, no earnings risk, and assignment is desirable (you own a
--   diversified ETF). They also serve as the primary candidates for the future
--   covered strangle strategy (backlog: activate when VIX < 25 + 2 clean fills).
--
--   Premium yield floor for index ETFs is 1.2%/month (vs 1.5% for stocks).
--   In normal VIX they generate 0.8-1.0%; in elevated VIX (current) 1.2-1.8%.
--   The is_index_etf flag lets the scanner apply the right floor without a new tier.

-- 1. Add is_index_etf column (default false — all existing rows unaffected)
ALTER TABLE options_watchlist
  ADD COLUMN IF NOT EXISTS is_index_etf BOOLEAN NOT NULL DEFAULT false;

-- 2. Add VPU, VYM, VIG as STABLE-tier index ETFs
INSERT INTO options_watchlist (ticker, tier, active, added_by, notes, sector, is_index_etf)
VALUES
  ('VPU',  'STABLE', true, 'system',
   'Vanguard Utilities ETF — ultra-low beta (~0.5), defensive, range-bound, ideal wheel + strangle candidate',
   'Utilities', true),
  ('VYM',  'STABLE', true, 'system',
   'Vanguard High Dividend Yield ETF — 400+ dividend payers, stable price action, low beta (~0.8)',
   'Financials', true),
  ('VIG',  'STABLE', true, 'system',
   'Vanguard Dividend Appreciation ETF — quality compounders, consistent dividend growth, beta ~0.85',
   'Financials', true)
ON CONFLICT (ticker) DO UPDATE SET
  tier         = EXCLUDED.tier,
  active       = EXCLUDED.active,
  notes        = EXCLUDED.notes,
  sector       = EXCLUDED.sector,
  is_index_etf = EXCLUDED.is_index_etf;
