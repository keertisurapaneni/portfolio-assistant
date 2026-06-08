-- Fix: trigger creates ghost records when the auto-trader closes the paper_trade in DB
-- before the ib_fills INSERT arrives (both fire from the same orderStatus handler).
--
-- Race condition:
--   1. orderStatus Filled → placeMarketOrder resolves + insertIbFill fires (fire-and-forget)
--   2. execDetails fires → insertIbFill with side='SLD' → trigger section (5) runs
--   3. recordTradeClose is still in-flight, hasn't written ib_close_order_id yet
--   4. Trigger finds no order match → creates ghost → NOW have real + ghost for same trade
--
-- Fix: before the NOT EXISTS ghost-creation check, run an UPDATE that links any
-- recently-closed paper_trade (same ticker, closed within 3 minutes, no close order ID yet)
-- to this ib_fills row. The subsequent NOT EXISTS check then finds it and skips ghost creation.

CREATE OR REPLACE FUNCTION sync_ib_fill_to_paper_trades()
RETURNS TRIGGER AS $$
DECLARE
  v_pnl_sum        NUMERIC;
  v_inferred_mode  TEXT;
  v_inferred_src   TEXT;
BEGIN
  IF NEW.ticker IS NULL OR NEW.ticker = '' THEN RETURN NEW; END IF;

  -- (1) ENTRY FILL: promote SUBMITTED/PENDING → FILLED
  UPDATE paper_trades SET
    fill_price = NEW.fill_price,
    filled_at  = COALESCE(filled_at, NEW.filled_at),
    status     = CASE WHEN status IN ('PENDING','SUBMITTED') THEN 'FILLED' ELSE status END
  WHERE ib_order_id = NEW.order_id::text AND status IN ('PENDING','SUBMITTED','FILLED');

  -- (2) TP FILL
  UPDATE paper_trades SET
    close_price  = NEW.fill_price,
    closed_at    = COALESCE(closed_at, NEW.filled_at),
    status       = 'TARGET_HIT',
    pnl          = COALESCE(NEW.realized_pnl, (NEW.fill_price - fill_price) * quantity * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END),
    pnl_percent  = CASE WHEN fill_price > 0 THEN ROUND(((NEW.fill_price - fill_price) / fill_price * 100 * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END)::numeric, 2) ELSE NULL END,
    pnl_source   = CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
    close_reason = 'target_hit'
  WHERE ib_tp_order_id = NEW.order_id::text AND status = 'FILLED';

  -- (3) SL FILL
  UPDATE paper_trades SET
    close_price  = NEW.fill_price,
    closed_at    = COALESCE(closed_at, NEW.filled_at),
    status       = 'STOPPED',
    pnl          = COALESCE(NEW.realized_pnl, (NEW.fill_price - fill_price) * quantity * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END),
    pnl_percent  = CASE WHEN fill_price > 0 THEN ROUND(((NEW.fill_price - fill_price) / fill_price * 100 * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END)::numeric, 2) ELSE NULL END,
    pnl_source   = CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
    close_reason = 'stopped'
  WHERE ib_sl_order_id = NEW.order_id::text AND status = 'FILLED';

  -- (4) CLOSE FILL — update running pnl sum for ib_close_order_id matches
  IF NEW.realized_pnl IS NOT NULL THEN
    SELECT ROUND(SUM(f.realized_pnl)::numeric, 2) INTO v_pnl_sum
    FROM ib_fills f
    WHERE f.order_id = NEW.order_id AND f.ticker = NEW.ticker AND f.realized_pnl IS NOT NULL;

    UPDATE paper_trades SET pnl = v_pnl_sum, pnl_source = 'ib_realized'
    WHERE ib_close_order_id = NEW.order_id::text AND ticker = NEW.ticker
      AND status IN ('CLOSED', 'TARGET_HIT', 'STOPPED');
  END IF;

  -- (5) ORPHANED SELL — race-condition fix + ghost creation fallback
  IF NEW.side = 'SLD' THEN

    -- Race-condition fix: recordTradeClose writes ib_close_order_id to paper_trades AFTER
    -- placeMarketOrder resolves, but insertIbFill fires in the same handler before that
    -- DB write completes. Link any recently-closed trade for this ticker so the NOT EXISTS
    -- check below finds it and skips ghost creation.
    UPDATE paper_trades SET
      ib_close_order_id = NEW.order_id::text,
      pnl = COALESCE(
        CASE WHEN NEW.realized_pnl IS NOT NULL THEN NEW.realized_pnl ELSE NULL END,
        pnl
      ),
      pnl_source = CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE pnl_source END
    WHERE ticker = NEW.ticker
      AND status IN ('CLOSED', 'TARGET_HIT', 'STOPPED')
      AND ib_close_order_id IS NULL
      AND close_price IS NOT NULL
      AND closed_at > NOW() - INTERVAL '3 minutes';

    -- Inherit mode + strategy_source from most recent open position for orphaned sells.
    -- This prevents LONG_TERM loss cuts and SWING_TRADE fills from appearing as DAY_TRADEs.
    IF NOT EXISTS (
      SELECT 1 FROM paper_trades
      WHERE ib_order_id = NEW.order_id::text OR ib_tp_order_id = NEW.order_id::text
         OR ib_sl_order_id = NEW.order_id::text OR ib_close_order_id = NEW.order_id::text
    ) THEN
      SELECT mode, strategy_source INTO v_inferred_mode, v_inferred_src
      FROM paper_trades
      WHERE ticker = NEW.ticker AND status IN ('FILLED','PARTIAL','OPEN') AND signal = 'BUY'
      ORDER BY opened_at DESC LIMIT 1;

      INSERT INTO paper_trades (
        ticker, signal, mode, status, close_price, quantity,
        pnl, pnl_source, ib_close_order_id, close_reason, strategy_source,
        opened_at, filled_at, closed_at
      )
      SELECT NEW.ticker, 'BUY', COALESCE(v_inferred_mode, 'DAY_TRADE'), 'CLOSED',
        NEW.fill_price, NULL,
        COALESCE(NEW.realized_pnl, 0),
        CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
        NEW.order_id::text, 'ib_fill_auto_created', v_inferred_src,
        NEW.filled_at, NEW.filled_at, NEW.filled_at
      WHERE NOT EXISTS (
        SELECT 1 FROM paper_trades WHERE ib_close_order_id = NEW.order_id::text AND ticker = NEW.ticker
      );
    END IF;

    -- Update running pnl sum (handles multi-fill orders)
    IF NEW.realized_pnl IS NOT NULL THEN
      SELECT ROUND(SUM(f.realized_pnl)::numeric, 2) INTO v_pnl_sum
      FROM ib_fills f
      WHERE f.order_id = NEW.order_id AND f.ticker = NEW.ticker AND f.realized_pnl IS NOT NULL;

      UPDATE paper_trades SET pnl = v_pnl_sum, pnl_source = 'ib_realized'
      WHERE ib_close_order_id = NEW.order_id::text AND ticker = NEW.ticker
        AND status IN ('CLOSED', 'TARGET_HIT', 'STOPPED');
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sync_ib_fill_trigger ON ib_fills;
CREATE TRIGGER sync_ib_fill_trigger
  AFTER INSERT OR UPDATE ON ib_fills
  FOR EACH ROW EXECUTE FUNCTION sync_ib_fill_to_paper_trades();
