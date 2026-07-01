-- Extend Section 4 of sync_ib_fill_to_paper_trades to also auto-close FILLED records
-- when a matching close fill arrives (ib_close_order_id match + realized_pnl available).
--
-- Root cause: ibBuyToCloseOption / ibSellToCloseOption can time out before receiving
-- the fill confirmation. In those cases stampPendingBtcOrder stamps ib_close_order_id,
-- but recordTradeClose() is never called — the record stays FILLED indefinitely.
-- The trigger's original Section 4 only wrote ib_pnl to already-CLOSED records.
-- This patch adds a second UPDATE that closes FILLED records when the fill arrives.
--
-- First seen: Jun 12 GOOGL OPTIONS_PUT (manual patch), Jul 1 ADI OPTIONS_PUT (manual patch).

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

    -- Update ib_pnl on already-closed records (original behavior)
    UPDATE paper_trades SET
      ib_pnl     = v_pnl_sum,
      pnl_source = 'ib_realized'
    WHERE ib_close_order_id = NEW.order_id::text
      AND ticker             = NEW.ticker
      AND status IN ('CLOSED', 'TARGET_HIT', 'STOPPED');

    -- NEW: Also close FILLED records when the close fill arrives.
    -- Handles timed-out BTC/STO orders where recordTradeClose() never ran.
    -- Leaves pnl (formula) untouched — display uses COALESCE(ib_pnl, pnl).
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
