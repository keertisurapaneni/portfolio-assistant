-- Auth + Broker Integration
-- portfolios: cloud storage for authenticated users (replaces localStorage)
-- broker_connections: SnapTrade credentials (server-side only)
-- user_settings: risk profile + preferences (cloud-synced)

-- ── portfolios ──
CREATE TABLE IF NOT EXISTS portfolios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  ticker text NOT NULL,
  name text,
  shares numeric,
  avg_cost numeric,
  date_added timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, ticker)
);

CREATE INDEX idx_portfolios_user ON portfolios(user_id);

ALTER TABLE portfolios ENABLE ROW LEVEL SECURITY;

CREATE POLICY "portfolios_select" ON portfolios FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "portfolios_insert" ON portfolios FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "portfolios_update" ON portfolios FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "portfolios_delete" ON portfolios FOR DELETE USING (auth.uid() = user_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER portfolios_updated_at
  BEFORE UPDATE ON portfolios
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── broker_connections ──
CREATE TABLE IF NOT EXISTS broker_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  snaptrade_user_id text NOT NULL,
  snaptrade_user_secret text NOT NULL,
  last_synced_at timestamptz,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE broker_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "broker_conn_select" ON broker_connections FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "broker_conn_insert" ON broker_connections FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "broker_conn_update" ON broker_connections FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "broker_conn_delete" ON broker_connections FOR DELETE USING (auth.uid() = user_id);

-- ── user_settings ──
CREATE TABLE IF NOT EXISTS user_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  risk_profile text NOT NULL DEFAULT 'moderate',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "settings_select" ON user_settings FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "settings_insert" ON user_settings FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "settings_update" ON user_settings FOR UPDATE USING (auth.uid() = user_id);
