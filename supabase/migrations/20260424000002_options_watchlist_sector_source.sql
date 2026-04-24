-- Add sector column + fix source attribution on options_watchlist
--
-- sector: populated for all current tickers so the UI can filter by sector
-- added_by: BABA was user-requested, mark it correctly; UI-added tickers use 'user'

ALTER TABLE options_watchlist
  ADD COLUMN IF NOT EXISTS sector TEXT;

COMMENT ON COLUMN options_watchlist.sector IS
  'Broad GICS-style sector: Technology, Financials, Health Care, Consumer Staples, Consumer Discretionary, Utilities, Communication Services';

-- Populate sectors for all seeded tickers
UPDATE options_watchlist SET sector = 'Technology'             WHERE ticker IN ('AAPL','MSFT','PLTR','APP','ALAB','CRDO','SNOW','NOW','DDOG','PANW','AVGO','ORCL','AMD');
UPDATE options_watchlist SET sector = 'Communication Services' WHERE ticker IN ('GOOGL','META','NFLX','RDDT');
UPDATE options_watchlist SET sector = 'Consumer Discretionary' WHERE ticker IN ('AMZN','TSLA','HD','BABA');
UPDATE options_watchlist SET sector = 'Consumer Staples'       WHERE ticker IN ('KO','COST','PG','WMT','MO');
UPDATE options_watchlist SET sector = 'Financials'             WHERE ticker IN ('JPM','MA','V','GS','BAC','WFC','C');
UPDATE options_watchlist SET sector = 'Health Care'            WHERE ticker IN ('UNH','JNJ','ABBV','PFE','MRK','CVS');
UPDATE options_watchlist SET sector = 'Semiconductors'         WHERE ticker IN ('NVDA');
UPDATE options_watchlist SET sector = 'Utilities'              WHERE ticker IN ('NEE','DUK');

-- BABA was added at the user's explicit request — mark it correctly
UPDATE options_watchlist SET added_by = 'user' WHERE ticker = 'BABA';
