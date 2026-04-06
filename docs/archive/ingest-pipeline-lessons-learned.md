# Ingest Pipeline: Lessons Learned & How They Were Fixed

**Last updated:** 2026-02-20

---

## What Went Wrong (Original Problems)

### 1. Tight coupling to auto-trader
- Ingest only ran every 10 min from auto-trader scheduler
- Result: users waited up to 10 min to see transcription results
- **Fix:** GitHub Actions triggers instantly when URLs are queued. YouTube auto-fetches captions serverlessly.

### 2. Vercel serverless as "solution"
- `api/run_ingest.py` was added to run Python ingest in Vercel
- Vercel has no ffmpeg → Instagram downloads failed
- 60s timeout → could not finish multiple videos
- **Fix:** Removed Vercel path. GitHub Actions provides ffmpeg + yt-dlp. YouTube bypasses yt-dlp entirely via captions API.

### 3. Multiple confusing trigger paths
- `process-strategy-video-queue` called INGEST_TRIGGER_URL
- Frontend called `trigger-transcript-ingest` → which also called INGEST_TRIGGER_URL
- Auto-trader still ran ingest every 10 min
- **Fix:** Single clear path per platform (see current architecture below).

### 4. No bridge from extracted signals to auto-trader
- Even when extraction succeeded, `extracted_signals` in `strategy_videos` didn't automatically create rows in `external_strategy_signals`
- Result: no trades ever fired from daily_signal videos
- **Fix:** New `import-strategy-signals` edge function is called automatically after extraction. It converts `extracted_signals` → `PENDING external_strategy_signals` with correct `execute_on_date`, `execute_at`, `expires_at`.

### 5. Add Strategies as a separate page
- Disconnected from Strategy Performance — you'd add videos, then navigate away to see results
- No per-video progress visibility
- **Fix:** Add Videos panel merged directly into Strategy Performance tab with 3-step pipeline UI.

---

## Current Architecture (Working)

### Per-platform ingest paths

| Platform | Transcript method | Where it runs |
|----------|------------------|---------------|
| YouTube | YouTube captions API (serverless) | `fetch-youtube-transcript` edge function |
| Instagram | yt-dlp + Groq Whisper | GitHub Actions (`ingest-instagram.yml`) |
| Twitter | yt-dlp + Groq Whisper | GitHub Actions (`ingest-instagram.yml`) |

### Full flow

```
User pastes URL in Add Videos panel
  → addUrlsToQueue() → strategy_video_queue
  → processQueue() → process-strategy-video-queue edge function
      • Creates minimal strategy_videos row (visible in UI immediately)
      • YouTube → triggers fetch-youtube-transcript (serverless, instant)
      • Instagram/Twitter → triggers trigger-instagram-ingest
          → dispatches GitHub Actions repository_dispatch
          → Actions: ffmpeg + yt-dlp download → Groq Whisper transcribe
          → calls extract-strategy-metadata-from-transcript

extract-strategy-metadata-from-transcript (Groq Llama 3.3 70B)
  • Upserts transcript, strategy_type, video_heading, extracted_signals, trade_date
  • If daily_signal → fires import-strategy-signals (non-blocking)

import-strategy-signals
  • Reads extracted_signals from strategy_videos
  • Creates PENDING rows in external_strategy_signals
  • Sets execute_on_date = trade_date, execute_at/expires_at from execution_window_et

Auto-trader (runs every 15 min on market days)
  • getDueExternalStrategySignals() picks up PENDING rows for today
  • Checks execution window, FA validation, allocation
  • Executes via IB Gateway → paper_trade created
```

### Fallback (if GitHub Actions fails)

Instagram blocked by IP → video stays at ingest_status='pending' → user sees "Paste transcript" button in Strategy Perf tab → pastes text → extract fires → import fires.

---

## Secrets Required

| Secret | Location | Purpose |
|--------|----------|---------|
| `GROQ_API_KEY` | Supabase + GitHub | Transcription + metadata extraction |
| `GITHUB_TOKEN` | Supabase | `trigger-instagram-ingest` dispatches GitHub Actions |
| `SUPABASE_URL` | GitHub | Actions callback to Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | GitHub | Actions write to strategy_videos |
