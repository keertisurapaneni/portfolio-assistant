-- Write IB's FIFO realized P&L into ib_pnl, not pnl.
--
-- Before: trigger wrote IB's realized_pnl into pnl, overwriting the formula-based value.
--         This caused discrepancies because IB uses FIFO netting while our formula is per-trade.
--
-- After:
--   pnl    = formula-based (close_price - fill_price) * qty — untouched by this trigger.
--   ib_pnl = IB's FIFO realized P&L — written by this trigger when available.
--   Display: COALESCE(ib_pnl, pnl) in the frontend.
--
-- Sections:
--   (2) TP FILL: pnl = formula; ib_pnl = realized_pnl if available
--   (3) SL FILL: same
--   (4) CLOSE FILL (ib_close_order_id): ib_pnl = sum of realized_pnl across fills; pnl untouched
--   (5) ORPHANED SELL INSERT: ib_pnl = realized_pnl; pnl = 0 (no formula basis)
--   (5) ORPHANED SELL UPDATE: ib_pnl = running sum; pnl untouched

CREATE OR REPLACE FUNCTION sync_ib_fill_to_paper_trades()
RETURNS TRIGGER AS $$
DECLARE
  v_pnl_sum        NUMERIC;
  v_inferred_mode  TEXT;
  v_inferred_src   TEXT;
BEGIN
  IF NEW.ticker IS NULL OR NEW.ticker = '' THEN RETURN NEW; END IF;

  -- (1) ENTRY FILL: promote SUBMITTED/PENDING → FILLED; no P&L update
  UPDATE paper_trades SET
    fill_price = NEW.fill_price,
    filled_at  = COALESCE(filled_at, NEW.filled_at),
    status     = CASE WHEN status IN ('PENDING','SUBMITTED') THEN 'FILLED' ELSE status END
  WHERE ib_order_id = NEW.order_id::text AND status IN ('PENDING','SUBMITTED','FILLED');

  -- (2) TP FILL: formula → pnl; IB FIFO → ib_pnl (when available)
  UPDATE paper_trades SET
    close_price  = NEW.fill_price,
    closed_at    = COALESCE(closed_at, NEW.filled_at),
    status       = 'TARGET_HIT',
    pnl          = CASE
                     WHEN fill_price IS NOT NULL AND fill_price > 0
                     THEN ROUND(((NEW.fill_price - fill_price) * quantity * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END)::numeric, 2)
                     ELSE pnl
                   END,
    ib_pnl       = CASE WHEN NEW.realized_pnl IS NOT NULL THEN NEW.realized_pnl ELSE ib_pnl END,
    pnl_percent  = CASE WHEN fill_price > 0 THEN ROUND(((NEW.fill_price - fill_price) / fill_price * 100 * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END)::numeric, 2) ELSE NULL END,
    pnl_source   = CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
    close_reason = 'target_hit'
  WHERE ib_tp_order_id = NEW.order_id::text AND status = 'FILLED';

  -- (3) SL FILL: formula → pnl; IB FIFO → ib_pnl (when available)
  UPDATE paper_trades SET
    close_price  = NEW.fill_price,
    closed_at    = COALESCE(closed_at, NEW.filled_at),
    status       = 'STOPPED',
    pnl          = CASE
                     WHEN fill_price IS NOT NULL AND fill_price > 0
                     THEN ROUND(((NEW.fill_price - fill_price) * quantity * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END)::numeric, 2)
                     ELSE pnl
                   END,
    ib_pnl       = CASE WHEN NEW.realized_pnl IS NOT NULL THEN NEW.realized_pnl ELSE ib_pnl END,
    pnl_percent  = CASE WHEN fill_price > 0 THEN ROUND(((NEW.fill_price - fill_price) / fill_price * 100 * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END)::numeric, 2) ELSE NULL END,
    pnl_source   = CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
    close_reason = 'stopped'
  WHERE ib_sl_order_id = NEW.order_id::text AND status = 'FILLED';

  -- (4) CLOSE FILL — ib_close_order_id match: write running sum into ib_pnl; leave pnl (formula) alone
  IF NEW.realized_pnl IS NOT NULL THEN
    SELECT ROUND(SUM(f.realized_pnl)::numeric, 2) INTO v_pnl_sum
    FROM ib_fills f
    WHERE f.order_id = NEW.order_id AND f.ticker = NEW.ticker AND f.realized_pnl IS NOT NULL;

    UPDATE paper_trades SET
      ib_pnl     = v_pnl_sum,
      pnl_source = 'ib_realized'
    WHERE ib_close_order_id = NEW.order_id::text
      AND ticker             = NEW.ticker
      AND status IN ('CLOSED', 'TARGET_HIT', 'STOPPED');

    -- Also close FILLED records when the close fill arrives (handles timed-out BTC/STO orders where
    -- recordTradeClose() never ran because ibBuyToCloseOption / ibSellToCloseOption timed out).
    -- Uses IB's realized_pnl directly (ib_pnl); leaves pnl (formula) untouched.
    UPDATE paper_trades SET
      status       = 'CLOSED',
      close_price  = NEW.fill_price,
      closed_at    = COALESCE(closed_at, NEW.filled_at),
      ib_pnl       = v_pnl_sum,
      pnl_source   = 'ib_realized',
      close_reason = COALESCE(close_reason, 'ib_close_fill')
    WHERE ib_close_order_id = NEW.order_id::text
      AND ticker             = NEW.ticker
      AND status             = 'FILLED';
  END IF;

  -- (5) ORPHANED SELL — inherit mode + strategy_source from most recent open position.
  -- This prevents LONG_TERM loss cuts and SWING_TRADE fills from appearing as DAY_TRADEs.
  IF NEW.side = 'SLD' THEN
    IF NOT EXISTS (
      SELECT 1 FROM paper_trades
      WHERE ib_order_id = NEW.order_id::text OR ib_tp_order_id = NEW.order_id::text
         OR ib_sl_order_id = NEW.order_id::text OR ib_close_order_id = NEW.order_id::text
    ) THEN
      SELECT mode, strategy_source INTO v_inferred_mode, v_inferred_src
      FROM paper_trades
      WHERE ticker = NEW.ticker AND status IN ('FILLED','PARTIAL','OPEN') AND signal = 'BUY'
      ORDER BY opened_at DESC LIMIT 1;

      -- pnl = 0 (no formula basis — fill_price unknown for orphaned sells)
      -- ib_pnl = IB's realized P&L (the authoritative number)
      INSERT INTO paper_trades (
        ticker, signal, mode, status, close_price, quantity,
        pnl, ib_pnl, pnl_source, ib_close_order_id, close_reason, strategy_source,
        opened_at, filled_at, closed_at
      )
      SELECT NEW.ticker, 'BUY', COALESCE(v_inferred_mode, 'DAY_TRADE'), 'CLOSED',
        NEW.fill_price, NULL,
        0,
        NEW.realized_pnl,
        CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
        NEW.order_id::text, 'ib_fill_auto_created', v_inferred_src,
        NEW.filled_at, NEW.filled_at, NEW.filled_at
      WHERE NOT EXISTS (
        SELECT 1 FROM paper_trades WHERE ib_close_order_id = NEW.order_id::text AND ticker = NEW.ticker
      );
    END IF;

    -- Update running ib_pnl sum (handles multi-fill orders); leave pnl (formula) alone
    IF NEW.realized_pnl IS NOT NULL THEN
      SELECT ROUND(SUM(f.realized_pnl)::numeric, 2) INTO v_pnl_sum
      FROM ib_fills f
      WHERE f.order_id = NEW.order_id AND f.ticker = NEW.ticker AND f.realized_pnl IS NOT NULL;

      UPDATE paper_trades SET
        ib_pnl     = v_pnl_sum,
        pnl_source = 'ib_realized'
      WHERE ib_close_order_id = NEW.order_id::text
        AND ticker             = NEW.ticker
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


-- ── Live account mirror ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sync_live_ib_fill_to_live_trades()
RETURNS TRIGGER AS $$
DECLARE
  v_pnl_sum        NUMERIC;
  v_inferred_mode  TEXT;
  v_inferred_src   TEXT;
BEGIN
  IF NEW.ticker IS NULL OR NEW.ticker = '' THEN RETURN NEW; END IF;

  -- (1) ENTRY FILL
  UPDATE live_trades SET
    fill_price = CASE WHEN fill_price IS NULL THEN NEW.fill_price ELSE fill_price END,
    filled_at  = COALESCE(filled_at, NEW.filled_at),
    status     = CASE WHEN status IN ('PENDING', 'SUBMITTED') THEN 'FILLED' ELSE status END
  WHERE ib_order_id = NEW.order_id::text AND status IN ('PENDING', 'SUBMITTED', 'FILLED');

  -- (2) TP FILL
  UPDATE live_trades SET
    close_price  = NEW.fill_price,
    closed_at    = COALESCE(closed_at, NEW.filled_at),
    status       = 'TARGET_HIT',
    pnl          = CASE
                     WHEN fill_price IS NOT NULL AND fill_price > 0
                     THEN ROUND(((NEW.fill_price - fill_price) * quantity * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END)::numeric, 2)
                     ELSE pnl
                   END,
    ib_pnl       = CASE WHEN NEW.realized_pnl IS NOT NULL THEN NEW.realized_pnl ELSE ib_pnl END,
    pnl_percent  = CASE WHEN fill_price > 0 THEN ROUND(((NEW.fill_price - fill_price) / fill_price * 100 * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END)::numeric, 2) ELSE NULL END,
    pnl_source   = CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
    close_reason = 'target_hit'
  WHERE ib_tp_order_id = NEW.order_id::text AND status = 'FILLED';

  -- (3) SL FILL
  UPDATE live_trades SET
    close_price  = NEW.fill_price,
    closed_at    = COALESCE(closed_at, NEW.filled_at),
    status       = 'STOPPED',
    pnl          = CASE
                     WHEN fill_price IS NOT NULL AND fill_price > 0
                     THEN ROUND(((NEW.fill_price - fill_price) * quantity * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END)::numeric, 2)
                     ELSE pnl
                   END,
    ib_pnl       = CASE WHEN NEW.realized_pnl IS NOT NULL THEN NEW.realized_pnl ELSE ib_pnl END,
    pnl_percent  = CASE WHEN fill_price > 0 THEN ROUND(((NEW.fill_price - fill_price) / fill_price * 100 * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END)::numeric, 2) ELSE NULL END,
    pnl_source   = CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
    close_reason = 'stopped'
  WHERE ib_sl_order_id = NEW.order_id::text AND status = 'FILLED';

  -- (4) CLOSE FILL
  IF NEW.realized_pnl IS NOT NULL THEN
    SELECT ROUND(SUM(f.realized_pnl)::numeric, 2) INTO v_pnl_sum
    FROM live_ib_fills f
    WHERE f.order_id = NEW.order_id AND f.ticker = NEW.ticker AND f.realized_pnl IS NOT NULL;

    UPDATE live_trades SET ib_pnl = v_pnl_sum, pnl_source = 'ib_realized'
    WHERE ib_close_order_id = NEW.order_id::text AND ticker = NEW.ticker
      AND status IN ('CLOSED', 'TARGET_HIT', 'STOPPED');
  END IF;

  -- (5) ORPHANED SELL — inherit mode from existing open position
  IF NEW.side = 'SLD' THEN
    IF NOT EXISTS (
      SELECT 1 FROM live_trades
      WHERE ib_order_id = NEW.order_id::text OR ib_tp_order_id = NEW.order_id::text
         OR ib_sl_order_id = NEW.order_id::text OR ib_close_order_id = NEW.order_id::text
    ) THEN
      SELECT mode, strategy_source INTO v_inferred_mode, v_inferred_src
      FROM live_trades
      WHERE ticker = NEW.ticker AND status IN ('FILLED', 'PARTIAL', 'OPEN') AND signal = 'BUY'
      ORDER BY opened_at DESC LIMIT 1;

      INSERT INTO live_trades (ticker, signal, mode, status, close_price, quantity, pnl, ib_pnl, pnl_source, ib_close_order_id, close_reason, strategy_source, opened_at, filled_at, closed_at)
      SELECT NEW.ticker, 'BUY', COALESCE(v_inferred_mode, 'DAY_TRADE'), 'CLOSED',
        NEW.fill_price, NULL,
        0, NEW.realized_pnl,
        CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
        NEW.order_id::text, 'ib_fill_auto_created', v_inferred_src,
        NEW.filled_at, NEW.filled_at, NEW.filled_at
      WHERE NOT EXISTS (SELECT 1 FROM live_trades WHERE ib_close_order_id = NEW.order_id::text AND ticker = NEW.ticker);
    END IF;

    IF NEW.realized_pnl IS NOT NULL THEN
      SELECT ROUND(SUM(f.realized_pnl)::numeric, 2) INTO v_pnl_sum
      FROM live_ib_fills f
      WHERE f.order_id = NEW.order_id AND f.ticker = NEW.ticker AND f.realized_pnl IS NOT NULL;

      UPDATE live_trades SET ib_pnl = v_pnl_sum, pnl_source = 'ib_realized'
      WHERE ib_close_order_id = NEW.order_id::text AND ticker = NEW.ticker
        AND status IN ('CLOSED', 'TARGET_HIT', 'STOPPED');
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sync_live_ib_fill_trigger ON live_ib_fills;
CREATE TRIGGER sync_live_ib_fill_trigger
  AFTER INSERT OR UPDATE ON live_ib_fills
  FOR EACH ROW EXECUTE FUNCTION sync_live_ib_fill_to_live_trades();
