-- Fix the ib_fills → paper_trades sync trigger so that:
--
-- (A) When a commission report arrives ASYNCHRONOUSLY for a close/stale-close order
--     (e.g. the auto-trader called recordTradeClose before all fills settled), the
--     paper_trade.pnl is retroactively updated to IB's definitive realized P&L.
--     This requires matching on the `ib_close_order_id` column that recordTradeClose()
--     already writes when it closes a trade.
--
-- (B) When a SELL fill arrives that has NO matching paper_trade in ANY column
--     (ib_order_id, ib_tp_order_id, ib_sl_order_id, ib_close_order_id), a minimal
--     CLOSED paper_trade is auto-created so the fill always appears in Today's Activity.
--     Root cause: reconcileIBLongs sometimes places close sell orders (via checkStaleDayTrades)
--     for IB lots that were never tracked in paper_trades (confirmed XOM 2026-06-04: IB held
--     93 shares across 3 lots; DB only tracked 31; sold 31×3 times creating orphaned fills).
--
-- Same change applied to live_trades / live_ib_fills mirror.

-- ── Paper account ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sync_ib_fill_to_paper_trades()
RETURNS TRIGGER AS $$
DECLARE
  v_pnl_sum NUMERIC;
BEGIN
  -- Skip rows without ticker (orderStatus noise before execDetails arrives)
  IF NEW.ticker IS NULL OR NEW.ticker = '' THEN
    RETURN NEW;
  END IF;

  -- ── (1) ENTRY FILL ────────────────────────────────────────────────────────
  -- Update fill_price + promote PENDING/SUBMITTED → FILLED.
  -- Also repairs fill_price = NULL on already-closed trades (TARGET_HIT,
  -- STOPPED, CLOSED) in case the entry fill arrived with ticker = '' initially.
  UPDATE paper_trades SET
    fill_price  = CASE WHEN fill_price IS NULL THEN NEW.fill_price ELSE fill_price END,
    filled_at   = COALESCE(filled_at, NEW.filled_at),
    status      = CASE WHEN status IN ('PENDING', 'SUBMITTED') THEN 'FILLED' ELSE status END,
    pnl         = CASE
                    WHEN fill_price IS NULL AND status IN ('TARGET_HIT', 'STOPPED', 'CLOSED')
                         AND close_price IS NOT NULL AND quantity IS NOT NULL
                    THEN ROUND((
                           (close_price - NEW.fill_price) * quantity
                           * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END
                         )::numeric, 2)
                    ELSE pnl
                  END,
    pnl_percent = CASE
                    WHEN fill_price IS NULL AND status IN ('TARGET_HIT', 'STOPPED', 'CLOSED')
                         AND close_price IS NOT NULL AND NEW.fill_price > 0
                    THEN ROUND((
                           (close_price - NEW.fill_price) / NEW.fill_price * 100
                           * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END
                         )::numeric, 2)
                    ELSE pnl_percent
                  END
  WHERE ib_order_id = NEW.order_id::text
    AND (status IN ('PENDING', 'SUBMITTED', 'FILLED') OR fill_price IS NULL);

  -- ── (2) TP FILL ───────────────────────────────────────────────────────────
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
    pnl_source  = CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
    close_reason = 'target_hit'
  WHERE ib_tp_order_id = NEW.order_id::text
    AND status = 'FILLED';

  -- ── (3) SL FILL ───────────────────────────────────────────────────────────
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
    pnl_source  = CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
    close_reason = 'stopped'
  WHERE ib_sl_order_id = NEW.order_id::text
    AND status = 'FILLED';

  -- ── (4) CLOSE FILL — ib_close_order_id match ──────────────────────────────
  -- recordTradeClose() always writes ib_close_order_id when it closes a trade.
  -- If a commission report arrives after recordTradeClose already ran (timing gap),
  -- re-sum all realized_pnl for the order and write IB's definitive value.
  IF NEW.realized_pnl IS NOT NULL THEN
    SELECT ROUND(SUM(f.realized_pnl)::numeric, 2) INTO v_pnl_sum
    FROM ib_fills f
    WHERE f.order_id      = NEW.order_id
      AND f.ticker        = NEW.ticker
      AND f.realized_pnl IS NOT NULL;

    UPDATE paper_trades SET
      pnl        = v_pnl_sum,
      pnl_source = 'ib_realized'
    WHERE ib_close_order_id = NEW.order_id::text
      AND ticker             = NEW.ticker
      AND status IN ('CLOSED', 'TARGET_HIT', 'STOPPED');
  END IF;

  -- ── (5) ORPHANED SELL — no matching paper_trade anywhere ──────────────────
  -- If this SELL fill has no match on ANY order ID column, auto-create a minimal
  -- CLOSED paper_trade so the fill appears in Today's Activity without manual
  -- DB patching. Subsequent fills for the same order update pnl via the UPDATE below.
  -- We're the sole operator of this IB account — every IB execution was ours.
  IF NEW.side = 'SLD' THEN
    IF NOT EXISTS (
      SELECT 1 FROM paper_trades
      WHERE ib_order_id       = NEW.order_id::text
         OR ib_tp_order_id    = NEW.order_id::text
         OR ib_sl_order_id    = NEW.order_id::text
         OR ib_close_order_id = NEW.order_id::text
    ) THEN
      -- Insert only once per (order_id, ticker) — subsequent fills hit the UPDATE below
      INSERT INTO paper_trades (
        ticker, signal, mode, status,
        close_price, quantity,
        pnl, pnl_source,
        ib_close_order_id, close_reason,
        opened_at, filled_at, closed_at
      )
      SELECT
        NEW.ticker, 'BUY', 'DAY_TRADE', 'CLOSED',
        NEW.fill_price, NULL,
        COALESCE(NEW.realized_pnl, 0), CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
        NEW.order_id::text, 'ib_fill_auto_created',
        NEW.filled_at, NEW.filled_at, NEW.filled_at
      WHERE NOT EXISTS (
        SELECT 1 FROM paper_trades
        WHERE ib_close_order_id = NEW.order_id::text AND ticker = NEW.ticker
      );
    END IF;

    -- Whether we just inserted or already had a record, update pnl to the running sum
    -- (handles multi-fill orders where partial commission reports arrive one-by-one)
    IF NEW.realized_pnl IS NOT NULL THEN
      SELECT ROUND(SUM(f.realized_pnl)::numeric, 2) INTO v_pnl_sum
      FROM ib_fills f
      WHERE f.order_id      = NEW.order_id
        AND f.ticker        = NEW.ticker
        AND f.realized_pnl IS NOT NULL;

      UPDATE paper_trades SET
        pnl        = v_pnl_sum,
        pnl_source = 'ib_realized'
      WHERE ib_close_order_id = NEW.order_id::text
        AND ticker             = NEW.ticker
        AND status IN ('CLOSED', 'TARGET_HIT', 'STOPPED');
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Live account mirror (identical logic on live_ib_fills → live_trades) ─────
CREATE OR REPLACE FUNCTION sync_live_ib_fill_to_live_trades()
RETURNS TRIGGER AS $$
DECLARE
  v_pnl_sum NUMERIC;
BEGIN
  IF NEW.ticker IS NULL OR NEW.ticker = '' THEN
    RETURN NEW;
  END IF;

  -- (1) ENTRY FILL
  UPDATE live_trades SET
    fill_price  = CASE WHEN fill_price IS NULL THEN NEW.fill_price ELSE fill_price END,
    filled_at   = COALESCE(filled_at, NEW.filled_at),
    status      = CASE WHEN status IN ('PENDING', 'SUBMITTED') THEN 'FILLED' ELSE status END,
    pnl         = CASE
                    WHEN fill_price IS NULL AND status IN ('TARGET_HIT', 'STOPPED', 'CLOSED')
                         AND close_price IS NOT NULL AND quantity IS NOT NULL
                    THEN ROUND(((close_price - NEW.fill_price) * quantity * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END)::numeric, 2)
                    ELSE pnl
                  END,
    pnl_percent = CASE
                    WHEN fill_price IS NULL AND status IN ('TARGET_HIT', 'STOPPED', 'CLOSED')
                         AND close_price IS NOT NULL AND NEW.fill_price > 0
                    THEN ROUND(((close_price - NEW.fill_price) / NEW.fill_price * 100 * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END)::numeric, 2)
                    ELSE pnl_percent
                  END
  WHERE ib_order_id = NEW.order_id::text
    AND (status IN ('PENDING', 'SUBMITTED', 'FILLED') OR fill_price IS NULL);

  -- (2) TP FILL
  UPDATE live_trades SET
    close_price = NEW.fill_price, closed_at = COALESCE(closed_at, NEW.filled_at),
    status = 'TARGET_HIT',
    pnl = COALESCE(NEW.realized_pnl, (NEW.fill_price - fill_price) * quantity * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END),
    pnl_percent = CASE WHEN fill_price > 0 THEN ROUND(((NEW.fill_price - fill_price) / fill_price * 100 * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END)::numeric, 2) ELSE NULL END,
    pnl_source = CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
    close_reason = 'target_hit'
  WHERE ib_tp_order_id = NEW.order_id::text AND status = 'FILLED';

  -- (3) SL FILL
  UPDATE live_trades SET
    close_price = NEW.fill_price, closed_at = COALESCE(closed_at, NEW.filled_at),
    status = 'STOPPED',
    pnl = COALESCE(NEW.realized_pnl, (NEW.fill_price - fill_price) * quantity * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END),
    pnl_percent = CASE WHEN fill_price > 0 THEN ROUND(((NEW.fill_price - fill_price) / fill_price * 100 * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END)::numeric, 2) ELSE NULL END,
    pnl_source = CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
    close_reason = 'stopped'
  WHERE ib_sl_order_id = NEW.order_id::text AND status = 'FILLED';

  -- (4) CLOSE FILL — ib_close_order_id match
  IF NEW.realized_pnl IS NOT NULL THEN
    SELECT ROUND(SUM(f.realized_pnl)::numeric, 2) INTO v_pnl_sum
    FROM live_ib_fills f
    WHERE f.order_id = NEW.order_id AND f.ticker = NEW.ticker AND f.realized_pnl IS NOT NULL;

    UPDATE live_trades SET pnl = v_pnl_sum, pnl_source = 'ib_realized'
    WHERE ib_close_order_id = NEW.order_id::text AND ticker = NEW.ticker
      AND status IN ('CLOSED', 'TARGET_HIT', 'STOPPED');
  END IF;

  -- (5) ORPHANED SELL
  IF NEW.side = 'SLD' THEN
    IF NOT EXISTS (
      SELECT 1 FROM live_trades
      WHERE ib_order_id = NEW.order_id::text OR ib_tp_order_id = NEW.order_id::text
         OR ib_sl_order_id = NEW.order_id::text OR ib_close_order_id = NEW.order_id::text
    ) THEN
      INSERT INTO live_trades (ticker, signal, mode, status, close_price, quantity, pnl, pnl_source, ib_close_order_id, close_reason, opened_at, filled_at, closed_at)
      SELECT NEW.ticker, 'BUY', 'DAY_TRADE', 'CLOSED', NEW.fill_price, NULL,
        COALESCE(NEW.realized_pnl, 0), CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
        NEW.order_id::text, 'ib_fill_auto_created', NEW.filled_at, NEW.filled_at, NEW.filled_at
      WHERE NOT EXISTS (SELECT 1 FROM live_trades WHERE ib_close_order_id = NEW.order_id::text AND ticker = NEW.ticker);
    END IF;

    IF NEW.realized_pnl IS NOT NULL THEN
      SELECT ROUND(SUM(f.realized_pnl)::numeric, 2) INTO v_pnl_sum
      FROM live_ib_fills f
      WHERE f.order_id = NEW.order_id AND f.ticker = NEW.ticker AND f.realized_pnl IS NOT NULL;

      UPDATE live_trades SET pnl = v_pnl_sum, pnl_source = 'ib_realized'
      WHERE ib_close_order_id = NEW.order_id::text AND ticker = NEW.ticker
        AND status IN ('CLOSED', 'TARGET_HIT', 'STOPPED');
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
