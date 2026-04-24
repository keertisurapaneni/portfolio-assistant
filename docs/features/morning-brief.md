# Morning Brief

**Last updated:** 2026-04-24  
**Status:** Live — runs automatically at 8:00 AM ET weekdays (cloud, no laptop required)

---

## Overview

The Morning Brief is an AI-synthesized daily pre-market research dashboard. It replaces manual news scanning by automatically fetching market data, earnings, and economic events from Finnhub, synthesizing them via Llama 70B (Groq), and presenting a structured, scannable brief in the app.

**Goal:** Walk into the trading day already knowing the macro tone, key movers, upcoming economic events, and watchlist-relevant themes — without reading 30 articles.

---

## What It Contains

| Section | Source | Description |
|---------|--------|-------------|
| Market Snapshot | Finnhub news + AI | 2-3 sentence macro overview of overnight/pre-market tone |
| Macro Tone | AI synthesis | Broader context: inflation, Fed, geopolitics affecting the session |
| Top Movers | Finnhub news + AI | Key tickers with catalyst and directional bias (Bullish/Bearish/Volatile/Neutral) |
| Economic Calendar | Finnhub calendar | Today's scheduled economic releases with time, prior, and estimate |
| Earnings Today | Finnhub earnings | Companies reporting today (pre-market or after-close) with directional note |
| Research Themes | AI synthesis | 2-3 cross-cutting themes relevant to our watchlist (e.g. "AI capex cycle", "rate sensitivity") |
| Also on Radar | AI synthesis | Secondary names worth watching but not top movers |
| Week Ahead | AI synthesis | Broader outlook for the rest of the week |

---

## Architecture

```
Supabase pg_cron (8:00 AM ET weekdays)
  └─ private.trigger_morning_brief()
       └─ net.http_post → generate-morning-brief Edge Function
            └─ Fetches: Finnhub market news (last 12h)
            └─ Fetches: Finnhub earnings calendar (today)
            └─ Fetches: Finnhub economic calendar (today)
            └─ Calls: Groq/Llama 70B → structured JSON brief
            └─ Upserts: morning_briefs table (keyed by brief_date)

Auto-trader scheduler.ts (backup, laptop-dependent)
  └─ cron '0 8 * * 1-5' → generateMorningBrief()
       └─ Same flow as above (fires if auto-trader is running)

Frontend
  └─ /morning-brief (MorningBrief.tsx)
       └─ Reads from morning_briefs table
       └─ "Generate Now" button → calls edge function on demand
       └─ Date selector for past briefs (up to 10 days)
```

---

## Data Flow

1. **Fetch** (auto-trader `morning-brief.ts` OR edge function directly):
   - Finnhub `/news?category=general&minId=0` filtered to last 12 hours
   - Finnhub `/calendar/earnings?from=today&to=today`
   - Finnhub `/calendar/economic?from=today&to=today`

2. **Synthesize** (`generate-morning-brief` edge function):
   - Passes raw news headlines, earnings list, and economic events to Llama 70B
   - Prompt instructs model to produce structured JSON with all sections
   - JSON is validated and upserted into `morning_briefs` table

3. **Display** (`MorningBrief.tsx`):
   - Fetches latest brief from `morning_briefs` on page load
   - Shows empty state with "Generate Now" button if no brief exists for today
   - Past briefs selectable via date dropdown (up to 10 most recent)

---

## Cloud Scheduling (pg_cron)

The brief runs in Supabase's cloud — no laptop or auto-trader server required.

**Setup (one-time):** Run in Supabase SQL editor:
```sql
ALTER DATABASE postgres SET app.supabase_url = 'https://YOUR_PROJECT_REF.supabase.co';
ALTER DATABASE postgres SET app.supabase_anon_key = 'YOUR_ANON_KEY';
```
Then apply migration `20260424000005_morning_brief_pg_cron.sql`.

**Schedule:** `0 12 * * 1-5` UTC = 8:00 AM EDT / 7:00 AM EST (always within pre-market window).

---

## Database Schema

```sql
CREATE TABLE morning_briefs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_date    DATE NOT NULL UNIQUE,  -- keyed by date; one brief per day
  macro_snapshot   TEXT,               -- 2-3 sentence market overview
  macro_tone       TEXT,               -- broader context paragraph
  economic_events  JSONB,              -- array of { time_et, event, prior, estimate, importance }
  earnings         JSONB,              -- array of { ticker, when, note, direction }
  top_movers       JSONB,              -- array of { ticker, direction, catalyst, why }
  research_themes  JSONB,              -- array of { theme, tickers[], note }
  secondary_names  JSONB,              -- array of { ticker, direction, note }
  week_ahead       TEXT,               -- forward-looking paragraph
  raw_news_count   INT,                -- number of news items processed
  generated_at     TIMESTAMPTZ DEFAULT now()
);
```

---

## Key Files

| File | Purpose |
|------|---------|
| `auto-trader/src/lib/morning-brief.ts` | Fetches Finnhub data, calls edge function |
| `supabase/functions/generate-morning-brief/index.ts` | Edge function — Groq/Llama synthesis + DB upsert |
| `app/src/components/MorningBrief.tsx` | React UI component |
| `app/src/App.tsx` | Route `/morning-brief` + nav link |
| `supabase/migrations/20260424000004_morning_briefs.sql` | Creates `morning_briefs` table |
| `supabase/migrations/20260424000005_morning_brief_pg_cron.sql` | pg_cron cloud schedule |

---

## Environment Variables Required

| Variable | Where | Purpose |
|---------|-------|---------|
| `FINNHUB_API_KEY` | Edge Function secret | Fetches market news, earnings, economic calendar |
| `GROQ_API_KEY` | Edge Function secret | Llama 70B inference for AI synthesis |
| `app.supabase_url` | DB setting (ALTER DATABASE) | pg_cron → edge function URL |
| `app.supabase_anon_key` | DB setting (ALTER DATABASE) | pg_cron → edge function auth |

---

## On-Demand Generation

Any time during the day, click **"Generate Now"** in the Morning Brief tab. The button:
1. Calls `supabase.functions.invoke('generate-morning-brief')`
2. Waits ~12 seconds for generation to complete
3. Auto-refreshes the view to show the new brief

Useful when: arriving at the laptop after 8 AM, wanting an afternoon refresh after major news, or testing the feature.
