-- Options roll tracking
-- Implements "infinite rolling" cost basis chain from rolling-options strategy.
--
-- roll_count:     how many times this position has been rolled (0 = original entry)
-- rolled_from_id: FK to the previous generation of this position
-- close_reason:   'rolled' added as a valid reason

ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS roll_count    INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rolled_from_id UUID REFERENCES paper_trades(id);

COMMENT ON COLUMN paper_trades.roll_count IS
  '0 = original entry. Increments each time this position is rolled. Max 3 debit rolls enforced in code.';
COMMENT ON COLUMN paper_trades.rolled_from_id IS
  'Points to the previous generation of this position — enables full roll chain / cost basis reconstruction.';

CREATE INDEX IF NOT EXISTS idx_paper_trades_rolled_from ON paper_trades (rolled_from_id)
  WHERE rolled_from_id IS NOT NULL;
