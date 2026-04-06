# Strategy Video Ingestion Flow

**Last updated:** 2026-02-20

## Goal

User pastes a strategy video URL (Instagram / YouTube / Twitter) → video appears in Strategy Performance tab immediately → transcript and metadata are extracted automatically in the background → daily signals auto-execute via the auto-trader on the applicable trade date.

---

## UI Entry Point

**Strategy Performance tab → "Add Strategy Videos" collapsible panel** (top of page)

- Paste one or more URLs (one per line or comma-separated)
- Click "Add & Queue"
- Live queue status shows below — polls every 4 seconds while items are in-flight
- Videos appear under the correct source in the leaderboard as soon as the queue processes

The old `/strategy-queue` route has been removed — everything is in the Strategy Performance tab.

---

## Flow

```
1. User pastes URLs → addUrlsToQueue() → strategy_video_queue (status: pending)
2. processQueue() → process-strategy-video-queue edge function:
     - Parses URL → platform + video_id
     - Resolves source_name from existing strategy_videos (same source_handle → same name)
     - For Instagram URLs without handle: fetches page og:url to extract handle
     - Upserts minimal strategy_videos row (ingest_status: pending)
     - Triggers platform-specific ingest:
         YouTube  → fetch-youtube-transcript (serverless, immediate)
         Instagram/Twitter → trigger-instagram-ingest → GitHub Actions dispatch

3. YouTube path:
     fetch-youtube-transcript edge function:
       - Fetches caption tracks directly from YouTube's internal API
       - Picks best track (English manual > English auto-generated)
       - Sets ingest_status: transcribing → calls extract function → sets ingest_status: done

4. Instagram/Twitter path:
     GitHub Actions (ingest-instagram.yml):
       - Installs ffmpeg + yt-dlp + groq Python package
       - Downloads audio, transcribes with Groq Whisper
       - Calls extract-strategy-metadata-from-transcript with transcript
     Fallback: if Actions fails, user sees "Paste transcript" button in the 3-step pipeline UI

5. extract-strategy-metadata-from-transcript (Groq Llama 3.3 70B):
     - Extracts: source_name, source_handle, strategy_type, video_heading,
                 trade_date, execution_window_et, timeframe, extracted_signals, summary
     - Upserts to strategy_videos (ingest_status: done)
     - If strategy_type = 'daily_signal' → triggers import-strategy-signals (non-blocking)

6. import-strategy-signals:
     - Reads extracted_signals (longTriggerAbove/shortTriggerBelow/targets/stopLoss per ticker)
     - Creates PENDING rows in external_strategy_signals for each signal direction
     - Sets execute_on_date = trade_date
     - Sets execute_at / expires_at from execution_window_et (default: market close)
     - Idempotent: skips if signal already exists for same video + ticker + direction

7. Auto-trader (every 15 min, 9:00–16:30 ET, weekdays):
     - getDueExternalStrategySignals() picks up PENDING rows for today's ET date
     - Respects execute_at (don't execute before window opens)
     - Respects expires_at (mark EXPIRED if window closed)
     - Validates: FA recommendation, confidence, sector, allocation cap
     - Executes via IB Gateway → paper_trade created with strategy attribution
```

---

## 3-Step Pipeline UI

Each video in Strategy Performance shows:

| Step | Green | Amber/Red | Retry action |
|------|-------|-----------|--------------|
| **1 Source** | Known source name | "Unknown — needs assignment" | Use "Assign to:" dropdown |
| **2 Transcript** | "Transcribed" | "Pending" / "Failed" | YouTube: "Fetch captions" button; Instagram: "Paste transcript" button |
| **3 Metadata** | "Extracted (daily/generic)" | "Not extracted" | "Re-extract" button (uses existing transcript) |

---

## Generic vs Daily Signal Execution

| Type | How signals are created | Execution |
|------|------------------------|-----------|
| **daily_signal** | `import-strategy-signals` creates exact entry/stop/target signals | Auto-trader uses those exact prices. No scanner needed. |
| **generic_strategy** | Auto-trader creates signals from scanner candidates that match the strategy's timeframe | Entry/stop/target come from FA analysis, not the video |

---

## Secrets

| Secret | Where | Purpose |
|--------|-------|---------|
| `GROQ_API_KEY` | Supabase + GitHub Actions | Whisper transcription + Llama extraction |
| `GITHUB_TOKEN` | Supabase | `trigger-instagram-ingest` dispatches GitHub Actions |
| `SUPABASE_URL` | GitHub Actions | Callback to Supabase after ingest |
| `SUPABASE_SERVICE_ROLE_KEY` | GitHub Actions | Write to strategy_videos |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Video stuck at "Pending" (Instagram) | GitHub Actions blocked by Instagram IP | Use "Paste transcript" fallback |
| Video stuck at "Pending" (YouTube) | Caption tracks not available | Use "Paste transcript" fallback |
| Step 3 shows "Not extracted" | Groq extraction failed | Click "Re-extract" |
| Signal created but no trade | Trade date was in the past | Check `execute_on_date` in `external_strategy_signals` |
| Signal EXPIRED | execute_at window passed before auto-trader ran | Check auto-trader is running during market hours |
| Source shows "Unknown" | Instagram handle resolution failed | Use "Assign to:" dropdown in Strategy Perf |
