# Strategy System — Architecture

**Last updated:** 2026-04-22

## Overview

The portfolio-assistant ingests trading strategies from Instagram/YouTube/Twitter videos, extracts signals, executes them via IB Gateway as paper trades, and tracks performance per source/video.

---

## Project Structure

| Package/App | Purpose | Location |
|-------------|---------|----------|
| **app** | React 19 + Vite 7 frontend | `app/` |
| **auto-trader** | Node.js service (port 3001) — scheduler, IB Gateway bridge | `auto-trader/` |
| **Supabase Edge Functions** | Deno serverless | `supabase/functions/` |
| **Supabase PostgreSQL** | DB with RLS | `supabase/migrations/` |
| **GitHub Actions** | Instagram/Twitter ingest (yt-dlp + ffmpeg) | `.github/workflows/ingest-instagram.yml` |

**Routes:** `/` (Portfolio), `/signals` (Trade Signals), `/finds` (Suggested Finds), `/movers`, `/paper-trading` (includes Strategy Performance).

---

## 1. Strategy Ingestion

### Entry point

**Paper Trading → Strategies tab → "Add Strategy Videos" panel** (collapsible, top of page)

Paste URLs → queue → auto-triggered per platform:
- **YouTube:** `fetch-youtube-transcript` edge function (serverless, no yt-dlp)
- **Instagram/Twitter:** GitHub Actions `ingest-instagram.yml` (yt-dlp + ffmpeg + Groq Whisper)

See [`docs/cursor/2026-02-20-strategy-video-ingestion-flow.md`](./cursor/2026-02-20-strategy-video-ingestion-flow.md) for the full detailed flow.

### Strategy Types

| Type | Description | Signal creation |
|------|-------------|-----------------|
| **daily_signal** | Video with concrete levels (e.g. "TSLA above 414, target 420, stop 407") | `import-strategy-signals` edge function auto-creates PENDING `external_strategy_signals` immediately after extraction |
| **generic_strategy** | Rules/patterns (e.g. "enter on pullback to EMA") | Auto-trader creates signals from scanner candidates matching the strategy's timeframe |

**Critical:** Named analysts (Somesh, Kay Capitals) must always be `daily_signal`. If set as `generic_strategy`, their signals will be created for ALL scanner tickers instead of just their transcript picks. Changing to `daily_signal` in the UI automatically purges stale PENDING signals and re-imports only the correct tickers.

### Signal Generators vs Execution Strategies

A key distinction for trade attribution:

| Category | Examples | Ticker source | Attribution |
|----------|---------|---------------|-------------|
| **Signal generator** | Somesh, Kay Capitals | Picks their own tickers with their own entry/exit levels | `External signal · Somesh` |
| **Execution strategy** | Casper Clipping, Casper SMC Wisdom | Applies candlestick/SMC rules ON TOP of our scanner tickers | `Trade signal + Casper Clipping` |

If a ticker is in both our scanner (`trade_scans`) AND a signal generator fires it, the two trades are **independent** (different entry prices / targets). Both appear separately in Today's Activity.

Stale signals: if a `daily_signal` video fires on a date different from its `trade_date` (rescheduled due to holiday or late import), its heading won't match today's date — the UI treats it as an execution strategy and defers to `scannerTickers` for attribution.

Known signal generators are defined in `KNOWN_SIGNAL_GENERATORS` (`strategyVideoQueueApi.ts`) and `SIGNAL_GENERATORS` (`TodayActivityTab.tsx`).

### Source Attribution

Each signal and paper trade carries:
- `strategy_source` — source name (e.g. "Casper SMC Wisdom")
- `strategy_source_url` — `https://www.instagram.com/{handle}/`
- `strategy_video_id` — video ID
- `strategy_video_heading` — extracted title/heading (used to detect stale rescheduled signals)

---

## 2. Edge Functions — Ingest Pipeline

| Function | Purpose |
|----------|---------|
| `process-strategy-video-queue` | Creates minimal `strategy_videos` row; triggers platform-specific ingest |
| `fetch-youtube-transcript` | Fetches YouTube captions; calls extract |
| `trigger-instagram-ingest` | Dispatches GitHub Actions `repository_dispatch` for Instagram/Twitter |
| `extract-strategy-metadata-from-transcript` | Groq Llama 3.3 70B extracts metadata; triggers `import-strategy-signals` if daily_signal |
| `import-strategy-signals` | Converts `extracted_signals` → PENDING `external_strategy_signals` (idempotent) |
| `fix-unknown-strategy-sources` | Resolves Unknown sources by fetching Instagram og:url |
| `assign-strategy-videos-to-source` | Manual assignment of Unknown videos to a known source |

---

## 3. Auto-Queue Logic

**Location:** `auto-trader/src/scheduler.ts`

### Daily Signals (`autoQueueDailySignalsFromTrackedVideos`)

Runs as a safety net — `import-strategy-signals` should have already created these via edge function. Filters videos: `strategyType === 'daily_signal'`, `tradeDate` = today ET, `extractedSignals` present. Deduplicates by `sourceName + ticker + signal + mode + executeOnDate + strategyVideoId`.

### Generic Signals (`autoQueueGenericSignalsFromTrackedVideos`)

- Filters videos: `strategyType === 'generic_strategy'`
- For each scanner idea (confidence ≥ `minScannerConfidence`), creates one signal per applicable strategy
- Skips tickers with active trades
- Deduplicates per signal

---

## 4. Execution Pipeline

```
runSchedulerCycle()
  → autoQueueDailySignalsFromTrackedVideos()
  → autoQueueGenericSignalsFromTrackedVideos(allIdeas)
  → processExternalStrategySignals()
      → getDueExternalStrategySignals()   // PENDING, execute_on_date <= today ET
      → for each signal:
          - check execute_at (not yet in window? skip)
          - check expires_at (past window? mark EXPIRED)
          - for generic: FA validation (confidence, direction, HOLD rejection)
          - runPreTradeChecks() (allocation, sector, earnings)
          - executeExternalStrategySignal() → IB order → paper_trade
```

### Execution window (time-based signals)

`execution_window_et: { start: "09:35", end: "10:30" }` in `strategy_videos` → `import-strategy-signals` converts to UTC `execute_at` / `expires_at` on the signal.

---

## 5. Scheduler Timing

| Schedule | Description |
|----------|-------------|
| `*/15 9-16 * * 1-5` | Main scheduler — every 15 min, 9:00–16:30 ET, weekdays |
| `36 9 * * 1-5` | First Candle — 09:36 ET, weekdays |

Realtime-triggered execution: when `trade_scans` is updated, auto-trader runs execution immediately via Supabase Realtime (no waiting for next tick).

---

## 6. Allocation Logic

Per-stock multi-strategy allocation (`processExternalStrategySignals`):
- Group PENDING generic signals by `ticker::mode::signal::execute_on_date`
- If group > 1 (same ticker, multiple strategies): `allocationSplit = group.length`, each gets `1/n` of base size
- Purpose: compare strategies on same underlying with equal allocation

---

## 7. Strategy Performance UI

**Location:** Paper Trading → **Strategies** tab

| Component | Purpose |
|-----------|---------|
| Add Videos panel (top) | Collapsible URL input; live queue polling |
| 3-step pipeline per video | Source → Transcript → Metadata; platform-aware retry buttons |
| Source Leaderboard | Trades, Win Rate, Avg P&L, Total P&L, Videos — expand/collapse |
| Video drill-down | Per-video rows with trade samples, status, category selector |

Video links are platform-aware:
- Instagram: `https://www.instagram.com/reel/{videoId}/`
- YouTube: `https://www.youtube.com/watch?v={videoId}`
- Twitter: `https://twitter.com/i/status/{videoId}`

---

## 8. Data Models

### strategy_videos (DB table)

```typescript
{
  video_id: string;
  platform: 'instagram' | 'youtube' | 'twitter';
  source_handle?: string;
  source_name?: string;
  reel_url?: string;
  canonical_url?: string;
  video_heading?: string;
  strategy_type?: 'daily_signal' | 'generic_strategy';
  timeframe?: 'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM';
  applicable_timeframes?: string[];
  execution_window_et?: { start?: string; end?: string };
  trade_date?: string;
  ingest_status?: 'pending' | 'transcribing' | 'done' | 'failed';
  ingest_error?: string;
  transcript?: string;
  extracted_signals?: DailyVideoSignal[];
  status: 'tracked';
}
```

### external_strategy_signals (DB table)

```typescript
{
  id: string;
  source_name: string;
  source_url: string | null;
  strategy_video_id: string | null;
  strategy_video_heading: string | null;
  ticker: string;
  signal: 'BUY' | 'SELL';
  mode: 'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM';
  confidence: number;
  entry_price: number | null;   // null for generic strategies
  stop_loss: number | null;
  target_price: number | null;
  execute_on_date: string;       // YYYY-MM-DD ET
  execute_at: string | null;     // UTC ISO — start of execution window
  expires_at: string | null;     // UTC ISO — end of execution window
  status: 'PENDING' | 'EXECUTED' | 'FAILED' | 'SKIPPED' | 'EXPIRED' | 'CANCELLED';
}
```

---

## 9. Safeguards Against Miscategorization

When a video's `strategy_type` is changed to `daily_signal` in the UI:
1. All PENDING signals for that video are deleted from `external_strategy_signals`
2. `import-strategy-signals` is called to re-import only the correct transcript tickers
3. This fires automatically — no manual cleanup needed

When assigning an unknown video to a known signal generator (Somesh, Kay Capitals):
- The category dropdown auto-defaults to `Daily signal`
- An amber `⚠ Should be Daily signal` warning appears if left as Generic strategy

---

## 10. Key File Reference

| Concern | Primary Files |
|---------|---------------|
| Add Videos UI + 3-step pipeline | `app/src/components/PaperTrading/tabs/StrategyPerformanceTab.tsx` |
| Strategy API client + signal generators set | `app/src/lib/strategyVideoQueueApi.ts` |
| Queue processing | `supabase/functions/process-strategy-video-queue/index.ts` |
| YouTube captions | `supabase/functions/fetch-youtube-transcript/index.ts` |
| Instagram trigger | `supabase/functions/trigger-instagram-ingest/index.ts` |
| GitHub Actions ingest | `.github/workflows/ingest-instagram.yml` |
| Metadata extraction | `supabase/functions/extract-strategy-metadata-from-transcript/index.ts` |
| Signal import | `supabase/functions/import-strategy-signals/index.ts` |
| Scheduler & queue | `auto-trader/src/scheduler.ts` |
| Strategy performance API | `app/src/lib/paperTradesApi.ts` |

---

## Related Docs

- [docs/cursor/2026-02-20-strategy-video-ingestion-flow.md](./cursor/2026-02-20-strategy-video-ingestion-flow.md) — Full ingest flow detail
- [docs/cursor/2026-02-20-ingest-pipeline-lessons-learned.md](./cursor/2026-02-20-ingest-pipeline-lessons-learned.md) — What went wrong and how it was fixed
- [supabase/functions/README.md](../supabase/functions/README.md) — Edge function docs
