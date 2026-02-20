# Strategy Video Ingestion Flow

## Goal

Add strategy videos from Instagram/YouTube/Twitter, show them in Strategy Perf under the correct source, then enrich with transcript metadata. **Fully automated** — no manual steps.

## Flow

1. **Add URLs** — User pastes URLs on Add Strategies page → `strategy_video_queue`
2. **Quick add** — `process-strategy-video-queue` runs (auto on add, or manual "Process pending"):
   - Resolves `source_name` from existing `strategy_videos` by `source_handle` (kaycapitals → "Somesh | Day Trader | Investor")
   - For Instagram URLs without handle in path, fetches page to extract handle from og:url
   - Creates minimal `strategy_videos` row → **shows in Strategy Perf immediately**
3. **Transcript pipeline** (triggered when user adds videos, no auto-trader needed):
   - process-strategy-video-queue creates rows → triggers ingest (INGEST_TRIGGER_URL)
   - Frontend also triggers ingest after Process pending
   - Ingest worker (Vercel api/run_ingest): yt-dlp downloads → Groq Whisper or faster-whisper transcribes → extract (Groq) upserts
   - Fallback: auto-trader runs ingest every 10 min if scripts/.venv exists

## Key Decisions

- **No AI classification on quick add** — `strategy_type` (daily_signal vs generic_strategy) set from transcript, not page metadata
- **Source from transcript** — Gemini extracts source_name/source_handle from transcript (e.g. "Hey it's Somesh from Kay Capitals")
- **Process pending always visible** — Button shown even when 0 pending (disabled) so users know the feature exists

## Setup

### Option A: Vercel serverless (no auto-trader)

1. Deploy to Vercel — `api/run_ingest.py` runs ingest when triggered
2. Set Vercel env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GROQ_API_KEY`
3. Set Supabase secret: `INGEST_TRIGGER_URL` = `https://your-app.vercel.app/api/run_ingest`
4. When user adds videos → ingest runs automatically (no auto-trader)

### Option B: Auto-trader (local)

1. Python venv: `python3 -m venv scripts/.venv` + `pip install -r scripts/requirements.txt`
2. ffmpeg: `brew install ffmpeg`
3. Auto-trader runs ingest every 10 min when `scripts/.venv` exists

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Ingest stays "Pending" | Auto-trader not running | Start auto-trader; ingest runs every 10 min |
| `yt-dlp: No such file or directory` | yt-dlp not in PATH | Use venv: `scripts/.venv/bin/python scripts/ingest_video.py` |
| `ffprobe and ffmpeg not found` | ffmpeg not installed | `brew install ffmpeg` |
| Extract 500 | GROQ_API_KEY not set | `supabase secrets set GROQ_API_KEY=...` (same as ai-proxy) |
| Download failed (Instagram) | Rate limit / login required | Use `--cookies path/to/cookies.txt` with Instagram session |
| Vercel ingest: ffmpeg not found | Vercel serverless has no ffmpeg | Use auto-trader or Paste transcript for Instagram; YouTube may work |
