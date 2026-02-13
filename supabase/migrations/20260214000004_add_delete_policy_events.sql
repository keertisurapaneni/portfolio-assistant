-- Add DELETE policy for auto_trade_events (was missing)

CREATE POLICY "Anyone can delete auto trade events" ON auto_trade_events FOR DELETE USING (true);

GRANT DELETE ON auto_trade_events TO anon;
