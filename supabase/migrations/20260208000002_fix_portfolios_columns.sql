-- Fix: add columns that may be missing if table was created before full migration
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS shares numeric;
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS avg_cost numeric;
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS date_added timestamptz DEFAULT now();
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Ensure the trigger exists
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS portfolios_updated_at ON portfolios;
CREATE TRIGGER portfolios_updated_at
  BEFORE UPDATE ON portfolios
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
