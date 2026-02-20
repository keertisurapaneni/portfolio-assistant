-- strategy_videos: single source of truth for tracked strategy metadata
-- Replaces strategy-videos.json; app and auto-trader read from here.

CREATE TABLE strategy_videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'instagram'
    CHECK (platform IN ('instagram', 'twitter', 'youtube')),
  source_handle TEXT,
  source_name TEXT NOT NULL,
  reel_url TEXT,
  canonical_url TEXT,
  video_heading TEXT,
  strategy_type TEXT
    CHECK (strategy_type IN ('daily_signal', 'generic_strategy')),
  timeframe TEXT
    CHECK (timeframe IN ('DAY_TRADE', 'SWING_TRADE', 'LONG_TERM')),
  applicable_timeframes TEXT[] DEFAULT '{}',
  execution_window_et JSONB,
  trade_date DATE,
  extracted_signals JSONB,
  exempt_from_auto_deactivation BOOLEAN DEFAULT false,
  status TEXT NOT NULL DEFAULT 'tracked'
    CHECK (status IN ('tracked', 'deactivated', 'paused')),
  summary TEXT,
  tracked_at DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (platform, video_id)
);

CREATE INDEX idx_strategy_videos_status ON strategy_videos(status);
CREATE INDEX idx_strategy_videos_strategy_type ON strategy_videos(strategy_type);
CREATE INDEX idx_strategy_videos_trade_date ON strategy_videos(trade_date) WHERE trade_date IS NOT NULL;
CREATE INDEX idx_strategy_videos_source_name ON strategy_videos(source_name);

ALTER TABLE strategy_videos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read for all"
  ON strategy_videos FOR SELECT USING (true);

CREATE POLICY "Allow insert for service role"
  ON strategy_videos FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow update for service role"
  ON strategy_videos FOR UPDATE USING (true) WITH CHECK (true);

GRANT SELECT ON strategy_videos TO anon;
GRANT SELECT, INSERT, UPDATE ON strategy_videos TO service_role;

-- Seed from existing data (run once; idempotent via ON CONFLICT)
INSERT INTO strategy_videos (
  video_id, platform, source_handle, source_name, reel_url, canonical_url,
  video_heading, strategy_type, timeframe, applicable_timeframes, execution_window_et,
  trade_date, extracted_signals, exempt_from_auto_deactivation, status, summary, tracked_at
) VALUES
  (
    'DUTpgveDf7Y', 'instagram', 'casperclipping', 'Casper Clipping',
    'https://www.instagram.com/reel/DUTpgveDf7Y/?igsh=cWMzZTc2dnZkdThp',
    'https://www.instagram.com/casperclipping/reel/DUTpgveDf7Y/',
    'Candlesticks explained in less than a minute', 'generic_strategy', NULL,
    ARRAY['DAY_TRADE', 'SWING_TRADE'], NULL, NULL, NULL,
    true, 'tracked',
    'Candlestick reading framework: wick rejection, momentum (three same-color candles), engulfing reversal/continuation, and indecision-to-conviction expansion.',
    '2026-02-19'::date
  ),
  (
    'DU53Z_nEcZh', 'instagram', 'caspersmcwisdom', 'Casper SMC Wisdom',
    'https://www.instagram.com/reel/DU53Z_nEcZh/?igsh=MXAyN3V3bHRnamtiYQ%3D%3D',
    'https://www.instagram.com/caspersmcwisdom/reel/DU53Z_nEcZh/',
    'First Candle Rule (9:30-9:35 levels + FVG retest + engulfing)', 'generic_strategy', 'DAY_TRADE',
    ARRAY['DAY_TRADE'], '{"start":"09:35","end":"10:30"}'::jsonb, NULL, NULL,
    false, 'tracked',
    'Wait for the first 5-minute candle (9:30-9:35 AM EST), mark high/low, drop to 1-minute, require level break with fair value gap and engulfing confirmation on retest, target fixed 3R.',
    '2026-02-19'::date
  ),
  (
    'DU7exddkw-E', 'instagram', 'kaycapitals', 'Somesh | Day Trader | Investor',
    'https://www.instagram.com/reel/DU7exddkw-E/?igsh=NW0xdWV3MHVrOXds',
    'https://www.instagram.com/kaycapitals/reel/DU7exddkw-E/',
    '4 stocks day-trading gameplan for Thursday, February 19', 'daily_signal', 'DAY_TRADE',
    ARRAY['DAY_TRADE'], NULL, '2026-02-19'::date,
    '[{"ticker":"TSLA","longTriggerAbove":414,"longTargets":[416.9,420],"shortTriggerBelow":409,"shortTargets":[405.3,402.65]},{"ticker":"SPY","longTriggerAbove":689.15,"longTargets":[691.3,693],"shortTriggerBelow":683.9,"shortTargets":[681.6,679.8]},{"ticker":"QQQ","longTriggerAbove":609.8,"longTargets":[611.5,613.7],"shortTriggerBelow":603.25,"shortTargets":[600.7,598.1]}]'::jsonb,
    false, 'tracked',
    'Daily watchlist levels for TSLA, SPY, and QQQ with breakout and breakdown targets based on support/resistance.',
    '2026-02-19'::date
  )
ON CONFLICT (platform, video_id) DO NOTHING;
