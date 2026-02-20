# Ingest Pipeline: Lessons Learned (Ask Codex for Advice)

**Context:** Strategy video ingest = download (yt-dlp) → transcribe (Whisper) → extract metadata (LLM) → upsert to DB. Videos show in Strategy Perf under correct source.

---

## What Went Wrong

### 1. **Over-engineered the extract step**
- Used Gemini for metadata extraction (source_name, strategy_type, video_heading, extracted_signals)
- User correctly pointed out: **why do we need AI?** — most of this is regex/pattern matching
- Ticker + levels ("TSLA above 414"), source intro ("it's X from Y"), date patterns — all rule-based
- **Should have:** Built a rule-based extractor first. Zero cost, no quota, no API dependency.

### 2. **Tight coupling to auto-trader**
- Ingest only ran every 10 min from auto-trader scheduler
- User: "transcription and extract should work once a user uploads a video" — correct
- **Should have:** Triggered ingest when videos are added, not on a cron.

### 3. **Vercel serverless as "solution"**
- Added `api/run_ingest.py` to run Python ingest in Vercel
- **Problems:**
  - Vercel has no ffmpeg → Instagram downloads fail (yt-dlp needs it for DASH postprocessing)
  - 60s timeout → might not finish for multiple videos
  - User now has to configure INGEST_TRIGGER_URL, Vercel env vars, Supabase secrets
- **Result:** More moving parts, still doesn't work for Instagram.

### 4. **Switched to Groq instead of fixing root cause**
- Gemini hit 429 quota → switched extract to Groq
- Groq Whisper for transcribe (when GROQ_API_KEY set) — good for serverless bundle size
- But we never removed the AI dependency for extract when rule-based would have sufficed.

### 5. **Multiple trigger paths**
- process-strategy-video-queue calls INGEST_TRIGGER_URL
- Frontend calls trigger-transcript-ingest → which calls INGEST_TRIGGER_URL
- Auto-trader still runs ingest every 10 min if venv exists
- **Result:** Three ways to trigger, unclear which one "wins," harder to debug.

---

## Current State (Messy)

| Component | Purpose |
|-----------|---------|
| `scripts/ingest_video.py` | Download (yt-dlp) + transcribe (faster-whisper or Groq Whisper) + call extract edge fn |
| `extract-strategy-metadata-from-transcript` | Groq LLM extracts metadata from transcript |
| `trigger-transcript-ingest` | Edge fn that calls INGEST_TRIGGER_URL |
| `api/run_ingest.py` | Vercel serverless — runs ingest (no ffmpeg, Instagram fails) |
| Auto-trader scheduler | Runs ingest every 10 min (works, but user didn't want this dependency) |

**Dependencies:** yt-dlp, ffmpeg, faster-whisper (or Groq Whisper), Groq for extract, Python venv or Vercel.

---

## Questions for Codex

1. **Rule-based extractor:** Should we replace the Groq extract with regex/heuristics? What's the minimal set of patterns for source_name, source_handle, strategy_type, extracted_signals?

2. **Where should ingest run?** Options:
   - Auto-trader (works, user doesn't want it)
   - Vercel (no ffmpeg, Instagram fails)
   - Supabase Edge Function (can't run yt-dlp or Python)
   - Separate worker (Railway, Render) — another service to maintain
   - "Paste transcript" only — user does manual step

3. **Simpler architecture:** What's the minimal path from "user pastes URL" to "video shows in Strategy Perf with correct source"? Can we avoid Python entirely (e.g., Groq Whisper API + rule-based extract in edge fn, but we still need to get audio from Instagram URL)?

4. **Instagram without yt-dlp:** Is there a serverless-friendly way to get audio from an Instagram reel URL? Or should we just document "use Paste transcript for Instagram" and only auto-ingest YouTube/Twitter?
