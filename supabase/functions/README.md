# Supabase Edge Functions

This folder contains Supabase Edge Functions (serverless Deno functions) for Portfolio Assistant.

## Shared Modules (`_shared/`)

All shared code lives in `_shared/` and is imported by both `trading-signals` and `trade-scanner`. Edit shared modules → deploy both functions.

### `_shared/prompts.ts`

Single source of truth for AI trading prompts, rules, and system instructions. Both functions import the same `DAY_TRADE_SYSTEM`, `SWING_TRADE_SYSTEM`, rules, and scanner Pass 2 refine prompts.

### `_shared/indicators.ts`

Full technical indicator engine — 13 indicators computed from OHLCV candle data:

- RSI (14), MACD (12/26/9), EMA (20), SMA (50/200), ATR (14), ADX (14)
- Volume Ratio, Support/Resistance, EMA/SMA Crossover, Trend Classification
- Recent Move, Gap Detection

Both the scanner (Pass 2) and full analysis use `computeAllIndicators()` + `formatIndicatorsForPrompt()` from this module, guaranteeing identical indicator values for the same data.

### `_shared/data-fetchers.ts`

Yahoo Finance data utilities (no API key needed):

- `fetchCandles(ticker, interval, size)` — OHLCV candles (1min to weekly), with 1h→4h aggregation
- `fetchMarketSnapshot()` — SPY trend + VIX for market context
- `fetchYahooNews(ticker)` — recent headlines
- `fetchFundamentalsBatch(symbols)` — P/E, earnings date, analyst ratings (v7 quote API)
- `formatFundamentalsForAI()` / `formatNewsForAI()` — AI prompt formatters

### `_shared/analysis.ts`

Shared analysis pipeline used by `trading-signals` (full analysis):

- `prepareAnalysisContext(ticker, mode, lite?)` — fetches candles, computes all 13 indicators, gets market snapshot + news, formats everything for AI
- `MODE_INTERVALS` — candle timeframes per mode (day: 1m/15m/1h, swing: 4h/1d/1w)
- `CANDLE_SIZES` — how many candles to fetch per timeframe

---

## Functions

### `trading-signals`

Full AI analysis for a single ticker. Uses `prepareAnalysisContext` from `_shared/analysis.ts` to fetch Yahoo Finance candles, compute indicators, and build prompts. Runs parallel Gemini agents for sentiment + trade signal + long-term outlook.

**Data sources:** Yahoo Finance (candles, news, market context), Finnhub (fundamentals, earnings calendar).

### `trade-scanner`

Two-pass AI scanner for Trade Ideas:

- **Pass 1:** Yahoo screener finds movers → lightweight indicators → Gemini batch filters to top 5
- **Pass 2:** Each shortlisted ticker gets full 13-indicator analysis using the **same shared `computeAllIndicators` + `formatIndicatorsForPrompt`** code as full analysis. Day trades fetch 15min candles (matching FA); swing trades reuse daily OHLCV from chart enrichment (zero extra fetches).

Results cached in `trade_scans` table (day: 30 min TTL, swing: 6 hr TTL).

### `fetch-stock-data`

Secure proxy for Finnhub API calls with server-side caching (15 min TTL).

**Endpoints:** `quote`, `metrics`, `recommendations`, `earnings`

### `process-strategy-video-queue`

Processes pending `strategy_video_queue` items (quick add):

- Resolves `source_name` from existing `strategy_videos` by `source_handle` so new videos from same source (e.g. kaycapitals) group under canonical name (e.g. "Somesh | Day Trader | Investor")
- For Instagram URLs without handle in path, fetches page to extract handle from og:url
- Creates minimal `strategy_videos` row (video_id, platform, source, url) → shows in Strategy Perf immediately
- `strategy_type`, `extracted_signals`, `video_heading`, etc. are set by the transcript pipeline (see below)

### `extract-strategy-metadata-from-transcript`

Extracts metadata from transcript via Gemini and upserts to `strategy_videos`. Called by the ingest script.

**POST body:** `{ video_id, platform?, reel_url?, canonical_url?, transcript }`  
**Extracts:** source_name, source_handle, strategy_type, video_heading, trade_date, extracted_signals, summary, etc.

### Transcript pipeline (automatic)

1. User adds URLs → `process-strategy-video-queue` creates minimal rows
2. Auto-trader runs `scripts/ingest_video.py --from-strategy-videos` every 10 min
3. Ingest: yt-dlp downloads → faster-whisper transcribes → calls `extract-strategy-metadata-from-transcript` → upserts

Requires: `pip install -r scripts/requirements.txt` (yt-dlp, faster-whisper, requests)

### `fix-unknown-strategy-sources`

Repairs `strategy_videos` with `source_name = 'Unknown'`: fetches Instagram page, extracts handle, looks up canonical source from existing videos, updates the row. Auto-runs when Strategy Perf tab loads and Unknown sources exist.

### `assign-strategy-videos-to-source`

Manual fallback when auto-fix fails (e.g. Instagram blocks server-side fetch). Assigns Unknown videos to a known source.

**POST body:** `{ source_handle: string, source_name: string, video_ids?: string[] }`  
- If `video_ids` provided: only assign those videos  
- If omitted: assign all Unknown videos to the given source  

UI: Strategy Perf → Unknown row → "Assign to:" dropdown + Assign button.

---

## Deployment

### Prerequisites

- Supabase CLI: `brew install supabase/tap/supabase`
- Logged in: `supabase login`
- Project linked: `supabase link --project-ref <ref>`

### Secrets

```bash
supabase secrets set FINNHUB_API_KEY=<key>
supabase secrets set GEMINI_API_KEY=<key>
supabase secrets set GEMINI_API_KEY_2=<key>
# ... up to GEMINI_API_KEY_13 (sequential, no gaps)
```

### Deploy

```bash
# Deploy both signal functions (shared modules are bundled automatically)
npx supabase functions deploy trading-signals --no-verify-jwt
npx supabase functions deploy trade-scanner --no-verify-jwt
npx supabase functions deploy fetch-stock-data --no-verify-jwt
npx supabase functions deploy process-strategy-video-queue --no-verify-jwt
npx supabase functions deploy fix-unknown-strategy-sources --no-verify-jwt
npx supabase functions deploy assign-strategy-videos-to-source --no-verify-jwt
npx supabase functions deploy extract-strategy-metadata-from-transcript --no-verify-jwt
```

**Important:** When editing `_shared/` modules, redeploy **both** `trading-signals` and `trade-scanner`.
