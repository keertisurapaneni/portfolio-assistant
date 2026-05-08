-- Persistent storage for IB fill events. Replaces the volatile in-memory Map
-- that was lost on every auto-trader restart. Each fill from orderStatus or
-- execDetails is recorded here so fill prices survive restarts and can be
-- audited against IB's execution ledger.

CREATE TABLE ib_fills (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id integer NOT NULL,
  exec_id text,
  ticker text NOT NULL,
  side text NOT NULL,
  quantity numeric NOT NULL,
  fill_price numeric NOT NULL,
  commission numeric,
  filled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ib_fills ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read_ib_fills" ON ib_fills FOR SELECT USING (true);
CREATE POLICY "insert_ib_fills" ON ib_fills FOR INSERT WITH CHECK (true);
CREATE POLICY "update_ib_fills" ON ib_fills FOR UPDATE USING (true);

CREATE INDEX idx_ib_fills_order_id ON ib_fills(order_id);
CREATE INDEX idx_ib_fills_ticker_filled ON ib_fills(ticker, filled_at);

-- Also add missing_since column to paper_trades for the 2-cycle close guard.
-- When syncPositions detects a position is gone, it records the timestamp here
-- instead of immediately closing. Only closes after 2 consecutive cycles (~30 min).
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS missing_since timestamptz;
