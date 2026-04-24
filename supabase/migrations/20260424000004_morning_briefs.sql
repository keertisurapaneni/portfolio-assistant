-- Morning brief table — stores AI-synthesized daily market briefings
-- Generated at 8 AM ET each weekday from Finnhub news, earnings calendar,
-- and economic data releases.

CREATE TABLE IF NOT EXISTS morning_briefs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_date      DATE NOT NULL UNIQUE,
  macro_snapshot  TEXT,              -- 2-3 sentence market setup for the day
  macro_tone      TEXT,              -- extended macro context
  economic_events JSONB DEFAULT '[]', -- [{time, event, prior, estimate, importance}]
  earnings        JSONB DEFAULT '[]', -- [{ticker, when, eps_est, direction, note}]
  top_movers      JSONB DEFAULT '[]', -- [{ticker, direction, catalyst, why}]
  research_themes JSONB DEFAULT '[]', -- [{theme, tickers, note}]
  secondary_names JSONB DEFAULT '[]', -- [{ticker, direction, note}]
  week_ahead      TEXT,              -- key events coming in next 5 trading days
  raw_news_count  INT DEFAULT 0,     -- how many news items were processed
  generated_at    TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_morning_briefs_date ON morning_briefs (brief_date DESC);

COMMENT ON TABLE morning_briefs IS
  'AI-synthesized daily pre-market briefings. One row per trading day, upserted each morning at 8 AM ET.';
