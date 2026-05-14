-- Scanner watchlist: tickers promoted from profitable day trades and influencer signals.
-- Fed into the trade-scanner universe so winning tickers get re-evaluated.
CREATE TABLE scanner_watchlist (
  ticker           TEXT PRIMARY KEY,
  added_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  last_win_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  win_count        INTEGER NOT NULL DEFAULT 1,
  consecutive_wins INTEGER NOT NULL DEFAULT 1,
  avg_pnl          NUMERIC,
  source           TEXT NOT NULL DEFAULT 'day_trade_gainer',
  notes            TEXT,
  active           BOOLEAN NOT NULL DEFAULT true
);

ALTER TABLE scanner_watchlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read scanner_watchlist"   ON scanner_watchlist FOR SELECT USING (true);
CREATE POLICY "Anyone can insert scanner_watchlist"  ON scanner_watchlist FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update scanner_watchlist"  ON scanner_watchlist FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete scanner_watchlist"  ON scanner_watchlist FOR DELETE USING (true);
