-- Credit spread close confirmation via actual fill prices.
--
-- Problem: combo (NonGuaranteed) fills always have realized_pnl=null in ib_fills.
-- The old trigger section (4) requires realized_pnl IS NOT NULL, so it never fires
-- for credit spread closes. The scanner was calling recordTradeClose() immediately
-- with an estimated P&L from Greeks — Today's Activity showed the estimate, not
-- the actual fill price. Any error in the estimate caused a daily discrepancy.
--
-- Fix: new trigger section (4b) waits for both legs of the close order to arrive,
-- then computes P&L from actual fill prices:
--   net_debit = SLD_fill_price - BOT_fill_price
--   (IB MM convention for BUY combo close: SLD=what we paid, BOT=what we received)
--   P&L = (spread_net_credit - net_debit) × qty × 100
--
-- The scanner now skips recordTradeClose() when an IB close order was placed,
-- relying on this trigger to confirm the close. Fallback to estimated P&L only
-- when IB is disconnected (no order placed).

CREATE OR REPLACE FUNCTION sync_ib_fill_to_paper_trades()
RETURNS TRIGGER AS $$
DECLARE
  v_pnl_sum            NUMERIC;
  v_inferred_mode      TEXT;
  v_inferred_src       TEXT;
  -- credit spread close confirmation
  v_cs_id              UUID;
  v_cs_net_credit      NUMERIC;
  v_cs_qty             INTEGER;
  v_cs_fill_count      INTEGER;
  v_cs_bot_price       NUMERIC;
  v_cs_sld_price       NUMERIC;
  v_cs_net_debit       NUMERIC;
  v_cs_pnl             NUMERIC;
  v_cs_status          TEXT;
  v_cs_close_reason    TEXT;
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

  -- (4) CLOSE FILL — update running pnl sum for ib_close_order_id matches (stock trades)
  IF NEW.realized_pnl IS NOT NULL THEN
    SELECT ROUND(SUM(f.realized_pnl)::numeric, 2) INTO v_pnl_sum
    FROM ib_fills f
    WHERE f.order_id = NEW.order_id AND f.ticker = NEW.ticker AND f.realized_pnl IS NOT NULL;

    UPDATE paper_trades SET pnl = v_pnl_sum, pnl_source = 'ib_realized'
    WHERE ib_close_order_id = NEW.order_id::text AND ticker = NEW.ticker
      AND status IN ('CLOSED', 'TARGET_HIT', 'STOPPED');
  END IF;

  -- (4b) CREDIT SPREAD CLOSE CONFIRMATION
  -- Combo (NonGuaranteed) fills always have realized_pnl=null, so section (4) never fires.
  -- When ib_close_order_id matches a CREDIT_SPREAD in status=FILLED, wait for both legs
  -- (BOT + SLD), then compute actual P&L from fill prices and promote to closed.
  --
  -- IB market-maker convention for BUY combo close:
  --   BOT fill = MM bought from us (we received: long hedge sellback proceeds)
  --   SLD fill = MM sold to us     (we paid:     short leg buyback cost)
  --   net_debit = SLD_price - BOT_price
  --   P&L = (spread_net_credit - net_debit) × qty × 100
  SELECT id, spread_net_credit, quantity
  INTO v_cs_id, v_cs_net_credit, v_cs_qty
  FROM paper_trades
  WHERE ib_close_order_id = NEW.order_id::text
    AND mode = 'CREDIT_SPREAD'
    AND status = 'FILLED'
  LIMIT 1;

  IF v_cs_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_cs_fill_count
    FROM ib_fills
    WHERE order_id = NEW.order_id;

    IF v_cs_fill_count >= 2 THEN
      SELECT
        MAX(CASE WHEN side = 'BOT' THEN fill_price ELSE NULL END),
        MAX(CASE WHEN side = 'SLD' THEN fill_price ELSE NULL END)
      INTO v_cs_bot_price, v_cs_sld_price
      FROM ib_fills
      WHERE order_id = NEW.order_id;

      -- Net debit = what we paid to close (SLD) minus what we received (BOT)
      v_cs_net_debit := COALESCE(v_cs_sld_price, 0) - COALESCE(v_cs_bot_price, 0);

      -- P&L in dollars: credit received minus debit paid, × contracts × 100 shares/contract
      v_cs_pnl := ROUND(
        ((COALESCE(v_cs_net_credit, 0) - v_cs_net_debit) * COALESCE(v_cs_qty, 1) * 100)::numeric,
        2
      );

      v_cs_status       := CASE WHEN v_cs_pnl >= 0 THEN 'TARGET_HIT' ELSE 'STOPPED' END;
      v_cs_close_reason := CASE WHEN v_cs_pnl >= 0 THEN 'target_hit' ELSE 'stop_loss' END;

      UPDATE paper_trades SET
        status       = v_cs_status,
        close_price  = v_cs_net_debit,
        pnl          = v_cs_pnl,
        pnl_source   = 'ib_fill_calculated',
        close_reason = v_cs_close_reason,
        closed_at    = NEW.filled_at
      WHERE id = v_cs_id;
    END IF;
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
