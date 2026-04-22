-- Safety reset: disable options auto-trade (paper-trading only until go-live gate is met)
-- Re-enable via the Options Wheel toggle in the app once 2-month track record is established.
UPDATE auto_trader_config
SET options_auto_trade_enabled = false
WHERE id = 'default';
