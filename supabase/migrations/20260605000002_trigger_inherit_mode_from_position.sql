-- Fix orphaned SELL phantom records to inherit mode + strategy_source from the
-- existing open position for that ticker instead of always defaulting to DAY_TRADE.
--
-- Before: every ib_fill_auto_created record was mode='DAY_TRADE', causing LONG_TERM
-- loss cuts and SWING_TRADE fills to show as "Day" trades in Today's Activity.
--
-- After: the trigger looks up the most recent FILLED/PARTIAL/OPEN position for that
-- ticker and uses its mode and strategy_source. Falls back to 'DAY_TRADE' / NULL if
-- no open position is found.

CREATE OR REPLACE FUNCTION sync_ib_fill_to_paper_trades()
RETURNS TRIGGER AS $$
DECLARE
  v_pnl_sum        NUMERIC;
  v_inferred_mode  TEXT;
  v_inferred_src   TEXT;
BEGIN
  IF NEW.ticker IS NULL OR NEW.ticker = '' THEN
    RETURN NEW;
  END IF;

  -- (1) ENTRY FILL
  UPDATE paper_trades SET
    fill_price = NEW.fill_price,
    filled_at  = COALESCE(filled_at, NEW.filled_at),
    status     = CASE WHEN status IN ('PENDING', 'SUBMITTED') THEN 'FILLED' ELSE status END,
    updated_at = NOW()
  WHERE ib_order_id = NEW.order_id::text
    AND status IN ('PENDING', 'SUBMITTED', 'FILLED');

  -- (2) TP FILL
  UPDATE paper_trades SET
    close_price  = NEW.fill_price,
    closed_at    = COALESCE(closed_at, NEW.filled_at),
    status       = 'TARGET_HIT',
    pnl          = COALESCE(NEW.realized_pnl, (NEW.fill_price - fill_price) * quantity * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END),
    pnl_percent  = CASE WHEN fill_price > 0 THEN ROUND(((NEW.fill_price - fill_price) / fill_price * 100 * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END)::numeric, 2) ELSE NULL END,
    pnl_source   = CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
    close_reason = 'target_hit',
    updated_at   = NOW()
  WHERE ib_tp_order_id = NEW.order_id::text AND status = 'FILLED';

  -- (3) SL FILL
  UPDATE paper_trades SET
    close_price  = NEW.fill_price,
    closed_at    = COALESCE(closed_at, NEW.filled_at),
    status       = 'STOPPED',
    pnl          = COALESCE(NEW.realized_pnl, (NEW.fill_price - fill_price) * quantity * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END),
    pnl_percent  = CASE WHEN fill_price > 0 THEN ROUND(((NEW.fill_price - fill_price) / fill_price * 100 * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END)::numeric, 2) ELSE NULL END,
    pnl_source   = CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
    close_reason = 'stopped',
    updated_at   = NOW()
  WHERE ib_sl_order_id = NEW.order_id::text AND status = 'FILLED';

  -- (4) CLOSE FILL — ib_close_order_id match
  IF NEW.realized_pnl IS NOT NULL THEN
    SELECT ROUND(SUM(f.realized_pnl)::numeric, 2) INTO v_pnl_sum
    FROM ib_fills f
    WHERE f.order_id = NEW.order_id AND f.ticker = NEW.ticker AND f.realized_pnl IS NOT NULL;

    UPDATE paper_trades SET
      pnl        = v_pnl_sum,
      pnl_source = 'ib_realized'
    WHERE ib_close_order_id = NEW.order_id::text
      AND ticker             = NEW.ticker
      AND status IN ('CLOSED', 'TARGET_HIT', 'STOPPED');
  END IF;

  -- (5) ORPHANED SELL — no matching paper_trade on any order ID column.
  -- Inherit mode + strategy_source from the most recent open position for this ticker
  -- so LONG_TERM loss cuts don't appear as "Day" trades and SWING_TRADE fills stay SWING.
  IF NEW.side = 'SLD' THEN
    IF NOT EXISTS (
      SELECT 1 FROM paper_trades
      WHERE ib_order_id       = NEW.order_id::text
         OR ib_tp_order_id    = NEW.order_id::text
         OR ib_sl_order_id    = NEW.order_id::text
         OR ib_close_order_id = NEW.order_id::text
    ) THEN
      -- Look up the most recent open/filled position for this ticker to inherit its mode
      SELECT mode, strategy_source
      INTO   v_inferred_mode, v_inferred_src
      FROM   paper_trades
      WHERE  ticker  = NEW.ticker
        AND  status IN ('FILLED', 'PARTIAL', 'OPEN')
        AND  signal  = 'BUY'
      ORDER BY opened_at DESC
      LIMIT 1;

      INSERT INTO paper_trades (
        ticker, signal, mode, status,
        close_price, quantity,
        pnl, pnl_source,
        ib_close_order_id, close_reason,
        strategy_source,
        opened_at, filled_at, closed_at
      )
      SELECT
        NEW.ticker,
        'BUY',
        COALESCE(v_inferred_mode, 'DAY_TRADE'),
        'CLOSED',
        NEW.fill_price,
        NULL,
        COALESCE(NEW.realized_pnl, 0),
        CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
        NEW.order_id::text,
        'ib_fill_auto_created',
        v_inferred_src,
        NEW.filled_at, NEW.filled_at, NEW.filled_at
      WHERE NOT EXISTS (
        SELECT 1 FROM paper_trades
        WHERE ib_close_order_id = NEW.order_id::text AND ticker = NEW.ticker
      );
    END IF;

    -- Update pnl to running sum for multi-fill orders
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

-- Recreate trigger (DROP + CREATE to ensure the updated function is used)
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
  IF NEW.ticker IS NULL OR NEW.ticker = '' THEN
    RETURN NEW;
  END IF;

  -- (1) ENTRY FILL
  UPDATE live_trades SET
    fill_price = CASE WHEN fill_price IS NULL THEN NEW.fill_price ELSE fill_price END,
    filled_at  = COALESCE(filled_at, NEW.filled_at),
    status     = CASE WHEN status IN ('PENDING', 'SUBMITTED') THEN 'FILLED' ELSE status END,
    pnl        = CASE
                   WHEN status = 'FILLED' AND close_price IS NOT NULL AND fill_price IS NOT NULL
                   THEN (close_price - fill_price) * COALESCE(quantity, 0) * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END
                   ELSE pnl
                 END,
    updated_at = NOW()
  WHERE ib_order_id = NEW.order_id::text
    AND status IN ('PENDING', 'SUBMITTED', 'FILLED');

  -- (2) TP FILL
  UPDATE live_trades SET
    close_price  = NEW.fill_price,
    closed_at    = COALESCE(closed_at, NEW.filled_at),
    status       = 'TARGET_HIT',
    pnl          = COALESCE(NEW.realized_pnl, (NEW.fill_price - fill_price) * quantity * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END),
    pnl_percent  = CASE WHEN fill_price > 0 THEN ROUND(((NEW.fill_price - fill_price) / fill_price * 100 * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END)::numeric, 2) ELSE NULL END,
    pnl_source   = CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
    close_reason = 'target_hit',
    updated_at   = NOW()
  WHERE ib_tp_order_id = NEW.order_id::text AND status = 'FILLED';

  -- (3) SL FILL
  UPDATE live_trades SET
    close_price  = NEW.fill_price,
    closed_at    = COALESCE(closed_at, NEW.filled_at),
    status       = 'STOPPED',
    pnl          = COALESCE(NEW.realized_pnl, (NEW.fill_price - fill_price) * quantity * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END),
    pnl_percent  = CASE WHEN fill_price > 0 THEN ROUND(((NEW.fill_price - fill_price) / fill_price * 100 * CASE WHEN signal = 'SELL' THEN -1 ELSE 1 END)::numeric, 2) ELSE NULL END,
    pnl_source   = CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
    close_reason = 'stopped',
    updated_at   = NOW()
  WHERE ib_sl_order_id = NEW.order_id::text AND status = 'FILLED';

  -- (4) CLOSE FILL
  IF NEW.realized_pnl IS NOT NULL THEN
    SELECT ROUND(SUM(f.realized_pnl)::numeric, 2) INTO v_pnl_sum
    FROM live_ib_fills f
    WHERE f.order_id = NEW.order_id AND f.ticker = NEW.ticker AND f.realized_pnl IS NOT NULL;

    UPDATE live_trades SET pnl = v_pnl_sum, pnl_source = 'ib_realized'
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
      SELECT mode, strategy_source
      INTO   v_inferred_mode, v_inferred_src
      FROM   live_trades
      WHERE  ticker  = NEW.ticker
        AND  status IN ('FILLED', 'PARTIAL', 'OPEN')
        AND  signal  = 'BUY'
      ORDER BY opened_at DESC
      LIMIT 1;

      INSERT INTO live_trades (ticker, signal, mode, status, close_price, quantity, pnl, pnl_source, ib_close_order_id, close_reason, strategy_source, opened_at, filled_at, closed_at)
      SELECT NEW.ticker, 'BUY', COALESCE(v_inferred_mode, 'DAY_TRADE'), 'CLOSED',
        NEW.fill_price, NULL,
        COALESCE(NEW.realized_pnl, 0),
        CASE WHEN NEW.realized_pnl IS NOT NULL THEN 'ib_realized' ELSE 'ib_fill_calculated' END,
        NEW.order_id::text, 'ib_fill_auto_created', v_inferred_src,
        NEW.filled_at, NEW.filled_at, NEW.filled_at
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

DROP TRIGGER IF EXISTS sync_live_ib_fill_trigger ON live_ib_fills;
CREATE TRIGGER sync_live_ib_fill_trigger
  AFTER INSERT OR UPDATE ON live_ib_fills
  FOR EACH ROW EXECUTE FUNCTION sync_live_ib_fill_to_live_trades();
