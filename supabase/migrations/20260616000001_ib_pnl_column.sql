-- Add ib_pnl column to paper_trades and live_trades.
--
-- Separation of concerns:
--   pnl     = formula-based: (close_price - fill_price) * qty  — used for per-trade strategy analysis
--   ib_pnl  = IB's FIFO realized P&L — authoritative for display and IB reconciliation
--
-- Display logic: COALESCE(ib_pnl, pnl) — prefer IB's number when available, fall back to formula.
-- The trigger (20260616000002) writes ib_pnl; formula pnl stays as-is.

ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS ib_pnl NUMERIC;
ALTER TABLE live_trades  ADD COLUMN IF NOT EXISTS ib_pnl NUMERIC;
