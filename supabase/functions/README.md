# Supabase Edge Functions

Serverless Deno functions for Portfolio Assistant.

---

## Shared Modules (`_shared/`)

All shared code lives in `_shared/` and is imported by both `trading-signals` and `trade-scanner`. **When editing `_shared/`, redeploy both functions.**

### `_shared/prompts.ts`
Single source of truth for AI trading prompts and rules. Both scanner and FA import the same `DAY_TRADE_SYSTEM`, `SWING_TRADE_SYSTEM`, `DAY_TRADE_RULES`, `SWING_TRADE_RULES`, and scanner Pass 2 refine prompts.

### `_shared/indicators.ts`
Full 13-indicator engine from OHLCV data: RSI (14), MACD (12/26/9), EMA (20), SMA (50/200), ATR (14), ADX (14), Volume Ratio, Support/Resistance, EMA/SMA Crossover, Trend Classification, Recent Move, Gap Detection. Both scanner Pass 2 and full analysis call `computeAllIndicators()` + `formatIndicatorsForPrompt()`.

### `_shared/data-fetchers.ts`
Yahoo Finance utilities (no API key): `fetchCandles`, `fetchMarketSnapshot`, `fetchYahooNews`, `fetchFundamentalsBatch`, formatters.

### `_shared/analysis.ts`
Shared analysis pipeline used by `trading-signals`: `prepareAnalysisContext(ticker, mode)` — candles, 13 indicators, market snapshot, news, all formatted for AI.

---

## Functions

### Trade Analysis

#### `trading-signals`
Full AI analysis for a single ticker. Uses `prepareAnalysisContext` (Yahoo Finance candles + Finnhub fundamentals + indicators). Runs parallel Gemini agents: sentiment + trade signal + long-term outlook.

#### `trade-scanner`
Two-pass AI scanner for Trade Ideas:
- **Pass 1:** Yahoo screener → lightweight indicators → Gemini batch filter → top 5
- **Pass 2:** Each ticker gets full `computeAllIndicators` + `formatIndicatorsForPrompt` (same code as FA). Day: fetches 15min candles. Swing: reuses daily OHLCV from Pass 1.

Results cached in `trade_scans` (day: 30 min TTL, swing: 6 hr TTL).

#### `fetch-stock-data`
Secure Finnhub proxy with 15-min server-side cache. Endpoints: `quote`, `metrics`, `recommendations`, `earnings`.

---

### Strategy Video Ingest Pipeline

```
User pastes URL
  → process-strategy-video-queue
      YouTube  → fetch-youtube-transcript → extract-strategy-metadata-from-transcript
      Instagram/Twitter → trigger-instagram-ingest → GitHub Actions → extract-strategy-metadata-from-transcript
  → extract-strategy-metadata-from-transcript
      → import-strategy-signals  (if daily_signal)
```

#### `process-strategy-video-queue`
Processes pending `strategy_video_queue` items:
- Resolves `source_name` from existing `strategy_videos` by `source_handle`
- For Instagram URLs without handle: fetches page `og:url` to extract handle
- Upserts minimal `strategy_videos` row (`ingest_status: pending`) → visible in Strategy Perf immediately
- Auto-triggers platform-specific ingest (YouTube → caption fetch, Instagram/Twitter → GitHub Actions)

#### `fetch-youtube-transcript`
Fetches YouTube captions directly (no yt-dlp):
- Calls internal YouTube API to get caption tracks
- Picks best English track (manual > auto-generated)
- Sets `ingest_status: transcribing` → calls `extract-strategy-metadata-from-transcript` → `done`

**POST body:** `{ video_id: string }`

#### `trigger-instagram-ingest`
Dispatches GitHub Actions `repository_dispatch` event to run `ingest-instagram.yml`:
- Requires `GITHUB_TOKEN` (PAT with `repo` scope) and optionally `GITHUB_REPO` (default: `keertisurapaneni/portfolio-assistant`) Supabase secrets
- GitHub Actions installs ffmpeg + yt-dlp + groq, runs `scripts/ingest_video.py`

**POST body:** `{ video_ids?: string[] }` — specific reel IDs, or omit to process all pending

#### `extract-strategy-metadata-from-transcript`
Extracts metadata from transcript via **Groq Llama 3.3 70B**. Upserts to `strategy_videos`. Requires `GROQ_API_KEY`.

**POST body:** `{ video_id, platform?, reel_url?, canonical_url?, transcript }`

**Extracts:** `source_name`, `source_handle`, `strategy_type` (daily_signal/generic_strategy), `video_heading`, `trade_date`, `execution_window_et`, `timeframe`, `applicable_timeframes`, `extracted_signals`, `summary`

**Auto-trigger:** If `strategy_type = 'daily_signal'` and `extracted_signals` is non-empty, fires `import-strategy-signals` (non-blocking).

#### `import-strategy-signals`
Converts `extracted_signals` from a `strategy_videos` row into PENDING `external_strategy_signals`. Called automatically after extraction for daily_signal videos.

- `longTriggerAbove` → BUY signal with `entry_price`, `target_price` (longTargets[0]), `stop_loss`
- `shortTriggerBelow` → SELL signal with `entry_price`, `target_price` (shortTargets[0]), `stop_loss`
- Sets `execute_on_date = trade_date`, `execute_at/expires_at` from `execution_window_et` (defaults to market close)
- Idempotent: skips existing signals for same `video_id + ticker + signal` on the same date

**POST body:** `{ video_id: string }`

---

### Source Management

#### `fix-unknown-strategy-sources`
Auto-repairs `strategy_videos` with `source_name = 'Unknown'`: fetches Instagram page, extracts handle, looks up canonical source. Also updates `external_strategy_signals` and `paper_trades` to remove duplicates. Auto-runs when Strategy Performance tab loads with Unknown sources.

#### `assign-strategy-videos-to-source`
Manual fallback for Unknown videos. Assigns to a known source + propagates to `external_strategy_signals` and `paper_trades`.

**POST body:** `{ source_handle, source_name, video_ids?, strategy_type?, cleanup? }`
- `video_ids`: specific videos (omit = all Unknown)
- `cleanup: true`: sync all assigned videos to remove stale Unknown references

#### `update-strategy-video-metadata`
Updates `strategy_type` or source on an existing `strategy_videos` row.

---

### Other Functions

#### `daily-suggestions`
Long-term AI stock suggestions (Quiet Compounders / Gold Mines). Uses HuggingFace.

#### `fetch-yahoo-news` / `scrape-market-movers`
News and market movers data.

#### `broker-connect` / `broker-sync`
SnapTrade broker integration (OAuth, positions sync).

#### `paper-trading-performance`
Computes performance metrics from `paper_trades` table.

#### `ai-proxy` / `gemini-proxy` / `huggingface-proxy`
Secure AI API proxies — serve API keys server-side.

#### `regime-spy`
Market regime detection.

#### `trade-performance-log-close`
Logs closed trade performance.

#### `trigger-transcript-ingest` *(legacy)*
Calls `INGEST_TRIGGER_URL` (old auto-trader trigger). Kept for backward compat but no longer used in the main flow.

---

## Secrets

```bash
# AI + transcription
supabase secrets set GROQ_API_KEY=<key>                       # Whisper transcription + Llama extraction
supabase secrets set GEMINI_API_KEY=<key>                     # trading-signals, trade-scanner
supabase secrets set GEMINI_API_KEY_2=<key>                   # rotate through up to _13

# Data
supabase secrets set FINNHUB_API_KEY=<key>
supabase secrets set ALPHA_VANTAGE_API_KEY=<key>

# Instagram ingest trigger
supabase secrets set GITHUB_TOKEN=<PAT with repo scope>        # trigger-instagram-ingest → GitHub Actions
supabase secrets set GITHUB_REPO=keertisurapaneni/portfolio-assistant  # optional, this is default

# Optional legacy
supabase secrets set INGEST_TRIGGER_URL=<url>                  # legacy Vercel trigger, no longer needed
```

### GitHub Actions secrets (set via `gh secret set`)

```bash
gh secret set SUPABASE_URL --body "https://..."
gh secret set SUPABASE_SERVICE_ROLE_KEY --body "eyJ..."
gh secret set GROQ_API_KEY --body "gsk_..."
```

---

## Deployment

```bash
# Core signal functions (always deploy together when _shared/ changes)
npx supabase functions deploy trading-signals --no-verify-jwt
npx supabase functions deploy trade-scanner --no-verify-jwt

# Data proxies
npx supabase functions deploy fetch-stock-data --no-verify-jwt
npx supabase functions deploy fetch-yahoo-news --no-verify-jwt

# Strategy ingest pipeline
npx supabase functions deploy process-strategy-video-queue --no-verify-jwt
npx supabase functions deploy fetch-youtube-transcript --no-verify-jwt
npx supabase functions deploy trigger-instagram-ingest --no-verify-jwt
npx supabase functions deploy extract-strategy-metadata-from-transcript --no-verify-jwt
npx supabase functions deploy import-strategy-signals --no-verify-jwt

# Source management
npx supabase functions deploy fix-unknown-strategy-sources --no-verify-jwt
npx supabase functions deploy assign-strategy-videos-to-source --no-verify-jwt
npx supabase functions deploy update-strategy-video-metadata --no-verify-jwt
```
