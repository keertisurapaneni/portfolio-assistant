-- Fix ib_fills sync trigger and backfill empty ticker rows.
--
-- Root cause: IB's execDetails callback sometimes sends contract.symbol = ''
-- for bracket TP/SL fills. The sync trigger skips empty-ticker rows, so
-- fill_price never gets written to paper_trades for those orders.
--
-- Also removes stale updated_at = NOW() references from the existing trigger —
-- paper_trades does not have an updated_at column (it was never added).
--
-- IMPORTANT: Rewrite the function FIRST so that the backfill UPDATEs below
-- (which fire this trigger) use the corrected version.

-- ── Step 1: Rewrite paper account trigger (remove updated_at, add fill_price repair) ──
CREATE OR REPLACE FUNCTION sync_ib_fill_to_paper_trades()
RETURNS TRIGGER AS $$
BEGIN
  -- Skip rows without ticker (orderStatus noise before execDetails arrives)
  IF NEW.ticker IS NULL OR NEW.ticker = '' THEN
    RETURN NEW;
  END IF;

  -- ENTRY FILL: update fill_price + promote PENDING/SUBMITTED → FILLED.
  -- Also repairs fill_price = NULL on already-closed trades (TARGET_HIT,
  -- STOPPED, CLOSED) in case the entry fill arrived with ticker = '' initially
  -- and was skipped by this trigger at insert time.
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
    close_reason = 'target_hit'
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
    close_reason = 'stopped'
  WHERE ib_sl_order_id = NEW.order_id::text
    AND status = 'FILLED';

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Step 2: Rewrite live account trigger (same fix) ───────────────────────────
CREATE OR REPLACE FUNCTION sync_live_ib_fill_to_live_trades()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.ticker IS NULL OR NEW.ticker = '' THEN
    RETURN NEW;
  END IF;

  UPDATE live_trades SET
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
    close_reason = 'target_hit'
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
    close_reason = 'stopped'
  WHERE ib_sl_order_id = NEW.order_id::text
    AND status = 'FILLED';

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Step 3: Backfill ib_fills.ticker from paper_trades order ID columns ───────
-- Now that the trigger function is fixed (no updated_at), these UPDATEs can
-- safely fire the trigger to repair fill_price on closed trades.

UPDATE ib_fills f
SET ticker = pt.ticker
FROM paper_trades pt
WHERE (f.ticker IS NULL OR f.ticker = '')
  AND pt.ib_order_id = f.order_id::text
  AND pt.ticker IS NOT NULL AND pt.ticker != '';

UPDATE ib_fills f
SET ticker = pt.ticker
FROM paper_trades pt
WHERE (f.ticker IS NULL OR f.ticker = '')
  AND pt.ib_tp_order_id = f.order_id::text
  AND pt.ticker IS NOT NULL AND pt.ticker != '';

UPDATE ib_fills f
SET ticker = pt.ticker
FROM paper_trades pt
WHERE (f.ticker IS NULL OR f.ticker = '')
  AND pt.ib_sl_order_id = f.order_id::text
  AND pt.ticker IS NOT NULL AND pt.ticker != '';

UPDATE live_ib_fills f
SET ticker = lt.ticker
FROM live_trades lt
WHERE (f.ticker IS NULL OR f.ticker = '')
  AND lt.ib_order_id = f.order_id::text
  AND lt.ticker IS NOT NULL AND lt.ticker != '';

UPDATE live_ib_fills f
SET ticker = lt.ticker
FROM live_trades lt
WHERE (f.ticker IS NULL OR f.ticker = '')
  AND lt.ib_tp_order_id = f.order_id::text
  AND lt.ticker IS NOT NULL AND lt.ticker != '';

UPDATE live_ib_fills f
SET ticker = lt.ticker
FROM live_trades lt
WHERE (f.ticker IS NULL OR f.ticker = '')
  AND lt.ib_sl_order_id = f.order_id::text
  AND lt.ticker IS NOT NULL AND lt.ticker != '';
