# Strategy Video Ingestion Flow

## Goal

Add strategy videos from Instagram/YouTube/Twitter, show them in Strategy Perf under the correct source, then enrich with transcript metadata.

## Flow

1. **Add URLs** — User pastes URLs on Add Strategies page → `strategy_video_queue`
2. **Quick add** — `process-strategy-video-queue` runs (auto on add, or manual "Process pending"):
   - Resolves `source_name` from existing `strategy_videos` by `source_handle` (kaycapitals → "Somesh | Day Trader | Investor")
   - For Instagram URLs without handle in path, fetches page to extract handle from og:url
   - Creates minimal `strategy_videos` row → **shows in Strategy Perf immediately**
3. **Transcript pipeline** — When run: transcribe → extract metadata → `upsert-strategy-video` with full payload
   - Updates same row with `strategy_type`, `extracted_signals`, `video_heading`, `trade_date`
   - Strategy Perf then shows complete metadata

## Key Decisions

- **No AI classification on quick add** — `strategy_type` (daily_signal vs generic_strategy) set from transcript, not page metadata
- **Source resolution from DB** — Look up `strategy_videos.source_handle` to reuse canonical `source_name`; new sources get humanized handle
- **Process pending always visible** — Button shown even when 0 pending (disabled) so users know the feature exists
