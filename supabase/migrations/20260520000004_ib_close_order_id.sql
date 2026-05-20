-- Add ib_close_order_id to paper_trades / live_trades so the trigger can
-- retroactively patch pnl with IB's net realized_pnl when the commission
-- report arrives after an EOD soft-close sell order.
--
-- Previously the trigger only matched entry/TP/SL order IDs.  EOD sweep
-- closes place a NEW sell orderId that was never stored on the paper_trade,
-- so the commission event had nothing to match on → gross P&L fallback.

ALTER TABLE paper_trades   ADD COLUMN IF NOT EXISTS ib_close_order_id text;
ALTER TABLE live_trades    ADD COLUMN IF NOT EXISTS ib_close_order_id text;

-- ── Update trigger: add 4th case for soft-close sells ─────────────────────

CREATE OR REPLACE FUNCTION sync_ib_fill_to_paper_trades()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.ticker IS NULL OR NEW.ticker = '' THEN
    RETURN NEW;
  END IF;

  -- ENTRY FILL: update fill_price + promote PENDING/SUBMITTED → FILLED
  UPDATE paper_trades SET
    fill_price = NEW.fill_price,
    filled_at  = COALESCE(filled_at, NEW.filled_at),
    status     = CASE WHEN status IN ('PENDING', 'SUBMITTED') THEN 'FILLED' ELSE status END,
    updated_at = NOW()
  WHERE ib_order_id = NEW.order_id::text
    AND status IN ('PENDING', 'SUBMITTED', 'FILLED');

  -- TP FILL: close trade as TARGET_HIT with IB's exact P&L when available
  UPDATE paper_trades SET
    close_price = NEW.fill_price,
    closed_at   = COALESCE(closed_at, NEW.filled_at),
    status      = 'TARGET_HIT',
    pnl         = COALESCE(
                    NEW.realized_pnl,
                    (NEW.fill_price - fill_price) * quantity
                      * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END
                  ),
    pnl_percent = CASE WHEN fill_price > 0 THEN
                    ROUND((
                      (NEW.fill_price - fill_price) / fill_price * 100
                      * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END
                    )::numeric, 2)
                  ELSE NULL END,
    pnl_source  = CASE WHEN NEW.realized_pnl IS NOT NULL
                    THEN 'ib_realized'
                    ELSE 'ib_fill_calculated'
                  END,
    close_reason = 'target_hit',
    updated_at   = NOW()
  WHERE ib_tp_order_id = NEW.order_id::text
    AND status = 'FILLED';

  -- SL FILL: close trade as STOPPED with IB's exact P&L when available
  UPDATE paper_trades SET
    close_price = NEW.fill_price,
    closed_at   = COALESCE(closed_at, NEW.filled_at),
    status      = 'STOPPED',
    pnl         = COALESCE(
                    NEW.realized_pnl,
                    (NEW.fill_price - fill_price) * quantity
                      * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END
                  ),
    pnl_percent = CASE WHEN fill_price > 0 THEN
                    ROUND((
                      (NEW.fill_price - fill_price) / fill_price * 100
                      * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END
                    )::numeric, 2)
                  ELSE NULL END,
    pnl_source  = CASE WHEN NEW.realized_pnl IS NOT NULL
                    THEN 'ib_realized'
                    ELSE 'ib_fill_calculated'
                  END,
    close_reason = 'stopped',
    updated_at   = NOW()
  WHERE ib_sl_order_id = NEW.order_id::text
    AND status = 'FILLED';

  -- EOD / SOFT-CLOSE FILL: patch pnl when commission arrives for a manual
  -- close sell that was placed by the EOD sweep or reconciler.  Only fires
  -- once realized_pnl is present (the commissionReport UPDATE), leaving the
  -- initial gross pnl set by recordTradeClose intact until then.
  UPDATE paper_trades SET
    pnl        = NEW.realized_pnl,
    pnl_source = 'ib_realized',
    updated_at = NOW()
  WHERE ib_close_order_id = NEW.order_id::text
    AND NEW.realized_pnl IS NOT NULL
    AND status IN ('CLOSED', 'TARGET_HIT', 'STOPPED');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Same update for live account ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION sync_live_ib_fill_to_live_trades()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.ticker IS NULL OR NEW.ticker = '' THEN
    RETURN NEW;
  END IF;

  UPDATE live_trades SET
    fill_price = NEW.fill_price,
    filled_at  = COALESCE(filled_at, NEW.filled_at),
    status     = CASE WHEN status IN ('PENDING', 'SUBMITTED') THEN 'FILLED' ELSE status END,
    updated_at = NOW()
  WHERE ib_order_id = NEW.order_id::text
    AND status IN ('PENDING', 'SUBMITTED', 'FILLED');

  UPDATE live_trades SET
    close_price  = NEW.fill_price,
    closed_at    = COALESCE(closed_at, NEW.filled_at),
    status       = 'TARGET_HIT',
    pnl          = COALESCE(
                     NEW.realized_pnl,
                     (NEW.fill_price - fill_price) * quantity
                       * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END
                   ),
    pnl_percent  = CASE WHEN fill_price > 0 THEN
                     ROUND((
                       (NEW.fill_price - fill_price) / fill_price * 100
                       * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END
                     )::numeric, 2)
                   ELSE NULL END,
    pnl_source   = CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
    close_reason = 'target_hit',
    updated_at   = NOW()
  WHERE ib_tp_order_id = NEW.order_id::text
    AND status = 'FILLED';

  UPDATE live_trades SET
    close_price  = NEW.fill_price,
    closed_at    = COALESCE(closed_at, NEW.filled_at),
    status       = 'STOPPED',
    pnl          = COALESCE(
                     NEW.realized_pnl,
                     (NEW.fill_price - fill_price) * quantity
                       * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END
                   ),
    pnl_percent  = CASE WHEN fill_price > 0 THEN
                     ROUND((
                       (NEW.fill_price - fill_price) / fill_price * 100
                       * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END
                     )::numeric, 2)
                   ELSE NULL END,
    pnl_source   = CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
    close_reason = 'stopped',
    updated_at   = NOW()
  WHERE ib_sl_order_id = NEW.order_id::text
    AND status = 'FILLED';

  -- EOD / SOFT-CLOSE FILL: patch pnl with IB's net realized_pnl on commission
  UPDATE live_trades SET
    pnl        = NEW.realized_pnl,
    pnl_source = 'ib_realized',
    updated_at = NOW()
  WHERE ib_close_order_id = NEW.order_id::text
    AND NEW.realized_pnl IS NOT NULL
    AND status IN ('CLOSED', 'TARGET_HIT', 'STOPPED');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
