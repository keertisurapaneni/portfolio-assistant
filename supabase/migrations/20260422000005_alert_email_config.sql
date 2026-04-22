-- Add alert email config to auto_trader_config
ALTER TABLE auto_trader_config
  ADD COLUMN IF NOT EXISTS alert_email TEXT,
  ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_deadmans_alert_at TIMESTAMPTZ;

COMMENT ON COLUMN auto_trader_config.alert_email IS 'Email address for critical engine failure alerts';
COMMENT ON COLUMN auto_trader_config.alerts_enabled IS 'Master switch for all email alerts';
COMMENT ON COLUMN auto_trader_config.last_deadmans_alert_at IS 'Prevents duplicate dead mans switch emails within 4h window';

-- Track sent alerts to prevent spam
CREATE TABLE IF NOT EXISTS alert_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type    TEXT NOT NULL,   -- 'deadmans_switch' | 'stop_loss' | 'assignment' | 'circuit_breaker' | 'auto_tune_failed'
  ticker        TEXT,
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  email_to      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS alert_log_sent_at_idx ON alert_log (sent_at DESC);
CREATE INDEX IF NOT EXISTS alert_log_type_idx ON alert_log (alert_type, sent_at DESC);
