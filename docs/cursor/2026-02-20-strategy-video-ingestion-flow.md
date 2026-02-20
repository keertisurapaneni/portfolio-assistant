# Strategy Video Ingestion Flow

## Goal

Add strategy videos from Instagram/YouTube/Twitter, show them in Strategy Perf under the correct source, then enrich with transcript metadata. **Fully automated** — no manual steps.

## Flow

1. **Add URLs** — User pastes URLs on Add Strategies page → `strategy_video_queue`
2. **Quick add** — `process-strategy-video-queue` runs (auto on add, or manual "Process pending"):
   - Resolves `source_name` from existing `strategy_videos` by `source_handle` (kaycapitals → "Somesh | Day Trader | Investor")
   - For Instagram URLs without handle in path, fetches page to extract handle from og:url
   - Creates minimal `strategy_videos` row → **shows in Strategy Perf immediately**
3. **Transcript pipeline** (automatic, every 10 min via auto-trader):
   - Fetches `strategy_videos` where `video_heading` IS NULL
   - yt-dlp downloads audio → faster-whisper transcribes
   - `extract-strategy-metadata-from-transcript` (Gemini) extracts: source_name, source_handle, strategy_type, video_heading, extracted_signals, trade_date, etc.
   - Upserts to `strategy_videos` → Strategy Perf shows complete metadata

## Key Decisions

- **No AI classification on quick add** — `strategy_type` (daily_signal vs generic_strategy) set from transcript, not page metadata
- **Source from transcript** — Gemini extracts source_name/source_handle from transcript (e.g. "Hey it's Somesh from Kay Capitals")
- **Process pending always visible** — Button shown even when 0 pending (disabled) so users know the feature exists

## Setup

```bash
pip install -r scripts/requirements.txt   # yt-dlp, faster-whisper, requests
```

Auto-trader runs the ingest automatically when `scripts/ingest_video.py` exists.
