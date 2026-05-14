-- Add realized_pnl to ib_fills so IB's FIFO-based P&L is captured per execution.
--
-- IB's commissionReport event provides realizedPNL which uses IB's actual FIFO cost
-- basis. This differs from our tracked fill_price when orphaned prior-day lots exist
-- (e.g. TSLA/AAPL on 2026-05-14 showed -$44.66/-$1.76 in our system but +$95.32/+$12.94
-- in IB because IB used cheaper prior-day lots via FIFO). Storing this allows the
-- EOD reconciler to use IB's authoritative P&L instead of recalculating from our entry.

ALTER TABLE ib_fills ADD COLUMN IF NOT EXISTS realized_pnl NUMERIC;

COMMENT ON COLUMN ib_fills.realized_pnl IS
  'IB FIFO-based realized P&L from commissionReport event. '
  'Commission-inclusive. Use this for paper_trade P&L when set — '
  'it accounts for prior-day orphaned lots that distort FIFO cost basis.';
