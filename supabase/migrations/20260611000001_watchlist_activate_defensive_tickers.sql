-- Activate three quality defensive tickers that sit in sectors with open capacity.
--
-- Why now: the active watchlist is 90%+ Tech/Comm Services. When Tech corrects,
-- the sector_limit gate (MAX_SECTOR_POSITIONS=3) blocks all new entries and the
-- scanner places 0 trades for days at a time (confirmed: 0 trades May 29 – Jun 11).
--
-- Chosen because:
--   1. Above SMA50 on 2026-06-11 (KO +6.2%, JNJ +3.9%, ABBV +7.3%) — pass the first gate
--   2. In sectors with 0 open positions (Health Care ≤1, Consumer Staples =0)
--   3. Stocks you'd genuinely want to own if assigned at a 15-20% discount
--   4. Minimal: only 3 tickers, enough to break the self-locking state without undoing the cleanup
--
-- Did NOT re-add: WMT (-3.7% below SMA50 today), BAC/WFC (Financials already has 3 active
-- tickers JPM/MA/V, adding more there doesn't help), PFE/CVS/MRK (higher news/pipeline risk).

UPDATE options_watchlist
SET    active = true,
       sector = 'Consumer Staples',
       notes  = 'Coca-Cola — defensive Consumer Staples, ~0.6 beta, stays above SMA50 during corrections; ideal wheel stock'
WHERE  ticker = 'KO';

UPDATE options_watchlist
SET    active = true,
       sector = 'Health Care',
       notes  = 'Johnson & Johnson — blue-chip pharma/medtech, 3.9% above SMA50 Jun-11; comfortable assignment at any discount'
WHERE  ticker = 'JNJ';

UPDATE options_watchlist
SET    active = true,
       sector = 'Health Care',
       notes  = 'AbbVie — persistently high IV rank (ESG + patent-cliff premium); 7.3% above SMA50 Jun-11; strong dividend if assigned'
WHERE  ticker = 'ABBV';
