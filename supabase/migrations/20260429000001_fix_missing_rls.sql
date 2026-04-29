-- Fix: Enable RLS on tables that were created without it.
-- Supabase flagged these as publicly accessible (rls_disabled_in_public).
-- All four are single-user system/log tables — policies mirror the pattern
-- used for auto_trade_events, options_watchlist, and other system tables.

-- ── alert_log ──────────────────────────────────────────────────────────────
ALTER TABLE alert_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read alert log"   ON alert_log FOR SELECT USING (true);
CREATE POLICY "Anyone can insert alert log" ON alert_log FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update alert log" ON alert_log FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete alert log" ON alert_log FOR DELETE USING (true);

-- ── morning_briefs ─────────────────────────────────────────────────────────
ALTER TABLE morning_briefs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read morning briefs"   ON morning_briefs FOR SELECT USING (true);
CREATE POLICY "Anyone can insert morning briefs" ON morning_briefs FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update morning briefs" ON morning_briefs FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete morning briefs" ON morning_briefs FOR DELETE USING (true);

-- ── options_watchlist_candidates ───────────────────────────────────────────
ALTER TABLE options_watchlist_candidates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read watchlist candidates"   ON options_watchlist_candidates FOR SELECT USING (true);
CREATE POLICY "Anyone can insert watchlist candidates" ON options_watchlist_candidates FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update watchlist candidates" ON options_watchlist_candidates FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete watchlist candidates" ON options_watchlist_candidates FOR DELETE USING (true);

-- ── strategy_tune_log ──────────────────────────────────────────────────────
ALTER TABLE strategy_tune_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read strategy tune log"   ON strategy_tune_log FOR SELECT USING (true);
CREATE POLICY "Anyone can insert strategy tune log" ON strategy_tune_log FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update strategy tune log" ON strategy_tune_log FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete strategy tune log" ON strategy_tune_log FOR DELETE USING (true);
