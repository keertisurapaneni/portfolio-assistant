-- ── Step 1: Deduplicate existing ib_fills rows ────────────────────────────
-- Keep one row per (order_id, COALESCE(exec_id,'')): prefer rows with a
-- non-empty ticker, then take the lowest id (earliest insert).

-- Paper account: delete all but the best row per natural key group
DELETE FROM ib_fills
WHERE id NOT IN (
  SELECT DISTINCT ON (order_id, COALESCE(exec_id, ''))
    id
  FROM ib_fills
  ORDER BY
    order_id,
    COALESCE(exec_id, ''),
    -- prefer rows with real ticker
    CASE WHEN ticker IS NOT NULL AND ticker != '' THEN 0 ELSE 1 END,
    id  -- then earliest
);

-- Live account
DELETE FROM live_ib_fills
WHERE id NOT IN (
  SELECT DISTINCT ON (order_id, COALESCE(exec_id, ''))
    id
  FROM live_ib_fills
  ORDER BY
    order_id,
    COALESCE(exec_id, ''),
    CASE WHEN ticker IS NOT NULL AND ticker != '' THEN 0 ELSE 1 END,
    id
);

-- ── Step 2: Unique index to prevent future duplicates ─────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS ib_fills_order_exec_uniq
  ON ib_fills (order_id, COALESCE(exec_id, ''));

CREATE UNIQUE INDEX IF NOT EXISTS live_ib_fills_order_exec_uniq
  ON live_ib_fills (order_id, COALESCE(exec_id, ''));

-- ── Step 3: Postgres trigger — ib_fills → paper_trades ───────────────────
-- Fires on INSERT and UPDATE (commission/pnl arriving from commissionReport).
-- Matches fills to paper_trades via ib_order_id (entry), ib_tp_order_id (TP),
-- and ib_sl_order_id (SL). Skips empty-ticker rows from orderStatus events.

CREATE OR REPLACE FUNCTION sync_ib_fill_to_paper_trades()
RETURNS TRIGGER AS $$
BEGIN
  -- Skip rows without ticker (orderStatus noise before execDetails arrives)
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_ib_fill_paper
  AFTER INSERT OR UPDATE ON ib_fills
  FOR EACH ROW EXECUTE FUNCTION sync_ib_fill_to_paper_trades();

-- ── Same trigger for live account ─────────────────────────────────────────

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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_ib_fill_live
  AFTER INSERT OR UPDATE ON live_ib_fills
  FOR EACH ROW EXECUTE FUNCTION sync_live_ib_fill_to_live_trades();
