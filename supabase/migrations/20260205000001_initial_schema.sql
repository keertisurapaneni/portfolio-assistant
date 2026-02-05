-- Portfolio Assistant Database Schema
-- Migration: Initial schema creation
-- Created: 2026-02-05

-- Table: portfolios
-- Stores user portfolio holdings with position data
CREATE TABLE portfolios (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ticker TEXT NOT NULL,
    shares NUMERIC,
    avg_cost NUMERIC,
    company_name TEXT,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Each user can only have one entry per ticker
    CONSTRAINT unique_user_ticker UNIQUE (user_id, ticker)
);

-- Index for fast user portfolio queries
CREATE INDEX idx_portfolios_user_id ON portfolios(user_id);

-- Table: stock_cache
-- Server-side cache for Finnhub API responses (15-min TTL)
CREATE TABLE stock_cache (
    ticker TEXT NOT NULL,
    endpoint TEXT NOT NULL CHECK (endpoint IN ('quote', 'metrics', 'recommendations', 'earnings')),
    data JSONB NOT NULL,
    cached_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Composite primary key: one cache entry per ticker+endpoint
    PRIMARY KEY (ticker, endpoint)
);

-- Index for TTL checks (find expired cache entries)
CREATE INDEX idx_stock_cache_cached_at ON stock_cache(cached_at);

-- Table: user_dismissals
-- Tracks which suggested stocks users have dismissed
CREATE TABLE user_dismissals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ticker TEXT NOT NULL,
    archetype TEXT NOT NULL,
    dismissed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Each user can only dismiss a specific ticker+archetype combo once
    CONSTRAINT unique_user_ticker_archetype UNIQUE (user_id, ticker, archetype)
);

-- Index for fast user dismissal queries
CREATE INDEX idx_user_dismissals_user_id ON user_dismissals(user_id);

-- Function: Update updated_at timestamp automatically
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger: Auto-update updated_at on portfolios table
CREATE TRIGGER update_portfolios_updated_at
    BEFORE UPDATE ON portfolios
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Comments for documentation
COMMENT ON TABLE portfolios IS 'User portfolio holdings with position data (shares, avg cost)';
COMMENT ON TABLE stock_cache IS 'Server-side cache for Finnhub API responses (15-min TTL)';
COMMENT ON TABLE user_dismissals IS 'Tracks dismissed stock suggestions per user';
COMMENT ON COLUMN portfolios.user_id IS 'References auth.users - enforced by RLS';
COMMENT ON COLUMN stock_cache.endpoint IS 'API endpoint type: quote, metrics, recommendations, or earnings';
COMMENT ON COLUMN stock_cache.data IS 'Cached JSON response from Finnhub API';
