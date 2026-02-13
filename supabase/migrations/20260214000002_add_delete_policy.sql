-- Add DELETE policy for paper_trades and trade_learnings
-- (was missing — only SELECT, INSERT, UPDATE were granted)

CREATE POLICY "Anyone can delete paper trades" ON paper_trades FOR DELETE USING (true);
CREATE POLICY "Anyone can delete trade learnings" ON trade_learnings FOR DELETE USING (true);

GRANT DELETE ON paper_trades TO anon;
GRANT DELETE ON trade_learnings TO anon;
