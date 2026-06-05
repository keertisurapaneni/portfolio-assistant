-- Fix the phantom race condition where a SELL fill arrives (triggering auto-create)
-- before the profit_take / loss_cut SELL record is saved to paper_trades.
--
-- Race condition flow:
--   1. Profit take places sell order → IB order ID returned
--   2. IB fill arrives immediately (milliseconds)
--   3. Trigger fires: no ib_close_order_id match yet → phantom BUY/DAY_TRADE created
--   4. Code then saves the LONG_TERM SELL record with ib_order_id = <order>
--   Result: both the phantom AND the real SELL record exist → P&L double-counted
--
-- Fix: whenever a SELL paper_trade is inserted with an ib_order_id,
--      delete any ib_fill_auto_created phantom that has ib_close_order_id = ib_order_id
--      for the same ticker. The phantom is redundant once the real record exists.

CREATE OR REPLACE FUNCTION cleanup_phantom_on_sell_insert()
RETURNS TRIGGER AS $$
BEGIN
  -- Only act on new SELL records that carry an ib_order_id (profit takes, loss cuts)
  IF NEW.signal = 'SELL' AND NEW.ib_order_id IS NOT NULL THEN
    DELETE FROM paper_trades
    WHERE ticker              = NEW.ticker
      AND ib_close_order_id  = NEW.ib_order_id
      AND close_reason        = 'ib_fill_auto_created';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cleanup_phantom_on_sell_insert_trigger ON paper_trades;
CREATE TRIGGER cleanup_phantom_on_sell_insert_trigger
  AFTER INSERT ON paper_trades
  FOR EACH ROW
  EXECUTE FUNCTION cleanup_phantom_on_sell_insert();

-- Mirror for live_trades
CREATE OR REPLACE FUNCTION cleanup_phantom_on_live_sell_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.signal = 'SELL' AND NEW.ib_order_id IS NOT NULL THEN
    DELETE FROM live_trades
    WHERE ticker              = NEW.ticker
      AND ib_close_order_id  = NEW.ib_order_id
      AND close_reason        = 'ib_fill_auto_created';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cleanup_phantom_on_live_sell_insert_trigger ON live_trades;
CREATE TRIGGER cleanup_phantom_on_live_sell_insert_trigger
  AFTER INSERT ON live_trades
  FOR EACH ROW
  EXECUTE FUNCTION cleanup_phantom_on_live_sell_insert();
