-- Portfolio Assistant Row Level Security (RLS) Policies
-- Migration: Enable RLS and create security policies
-- Created: 2026-02-05

-- ============================================================
-- PORTFOLIOS TABLE - User Isolation
-- ============================================================

-- Enable RLS on portfolios table
ALTER TABLE portfolios ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only SELECT their own portfolio data
CREATE POLICY "Users can view own portfolio"
    ON portfolios
    FOR SELECT
    USING (auth.uid() = user_id);

-- Policy: Users can only INSERT their own portfolio data
CREATE POLICY "Users can insert own portfolio"
    ON portfolios
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Policy: Users can only UPDATE their own portfolio data
CREATE POLICY "Users can update own portfolio"
    ON portfolios
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Policy: Users can only DELETE their own portfolio data
CREATE POLICY "Users can delete own portfolio"
    ON portfolios
    FOR DELETE
    USING (auth.uid() = user_id);

-- ============================================================
-- USER_DISMISSALS TABLE - User Isolation
-- ============================================================

-- Enable RLS on user_dismissals table
ALTER TABLE user_dismissals ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only SELECT their own dismissals
CREATE POLICY "Users can view own dismissals"
    ON user_dismissals
    FOR SELECT
    USING (auth.uid() = user_id);

-- Policy: Users can only INSERT their own dismissals
CREATE POLICY "Users can insert own dismissals"
    ON user_dismissals
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Policy: Users can only DELETE their own dismissals
CREATE POLICY "Users can delete own dismissals"
    ON user_dismissals
    FOR DELETE
    USING (auth.uid() = user_id);

-- ============================================================
-- STOCK_CACHE TABLE - Read-Only for All, Write via Service Role
-- ============================================================

-- Enable RLS on stock_cache table
ALTER TABLE stock_cache ENABLE ROW LEVEL SECURITY;

-- Policy: All authenticated users can read cache (shared cache benefits all users)
CREATE POLICY "Authenticated users can read cache"
    ON stock_cache
    FOR SELECT
    TO authenticated
    USING (true);

-- Policy: Only service role can insert/update/delete cache
-- (Edge Functions use service role to manage cache)
-- Note: Service role bypasses RLS, but this policy documents intent
CREATE POLICY "Service role can manage cache"
    ON stock_cache
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ============================================================
-- COMMENTS FOR DOCUMENTATION
-- ============================================================

COMMENT ON POLICY "Users can view own portfolio" ON portfolios IS 
    'RLS: Users can only see their own portfolio holdings';

COMMENT ON POLICY "Authenticated users can read cache" ON stock_cache IS 
    'RLS: Shared cache - all users benefit from cached API responses';

COMMENT ON POLICY "Service role can manage cache" ON stock_cache IS 
    'RLS: Only Edge Functions (service role) can write to cache';
