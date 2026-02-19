# Instagram Strategy System — Architecture

> Reference: [WORKLOG-2026-02-19.md](./WORKLOG-2026-02-19.md) for implementation details and commits.

## Overview

The portfolio-assistant ingests trading strategies from Instagram videos, queues them as external signals, executes them via IB Gateway, and tracks performance per source/video. This document describes the architecture and data flow.

---

## Project Structure

| Package/App | Purpose | Location |
|-------------|---------|----------|
| **app** | React 19 + Vite 7 frontend | `app/` |
| **auto-trader** | Node.js service (port 3001) — scheduler, IB Gateway bridge | `auto-trader/` |
| **Supabase Edge Functions** | Deno serverless (ai-proxy, trade-scanner, trading-signals, daily-suggestions) | `supabase/functions/` |
| **Supabase PostgreSQL** | DB with RLS | `supabase/migrations/` |

**Flow:** Browser → Supabase Edge Functions (AI, data) + auto-trader (IB Gateway) → IB paper account.

**Routes:** `/` (Portfolio), `/signals` (Trade Signals), `/finds` (Suggested Finds), `/movers`, `/paper-trading`.

---

## 1. Strategy Ingestion

### Config Files

| File | Purpose |
|------|---------|
| `auto-trader/strategy-videos.json` | Tracked videos (primary source for auto-trader) |
| `app/public/strategy-videos.json` | UI copy (drill-down, tracked videos) |
| `auto-trader/strategy-sources.json` | Source metadata (handle, URL) |

### Strategy Types

| Type | Description | Behavior |
|------|-------------|----------|
| **daily_signal** | Videos with `extractedSignals` (concrete levels) | Creates BUY/SELL signals with entry, stop, target for today ET |
| **generic_strategy** | Videos with no levels (e.g. candlestick rules) | Uses scanner ideas (confidence ≥ minScannerConfidence) and creates one signal per video per ticker |

### Source Attribution & Video Metadata

Each signal and paper trade carries:

- `strategy_source` — source name (e.g. "Casper Clipping")
- `strategy_source_url` — `https://www.instagram.com/{handle}/`
- `strategy_video_id` — video ID
- `strategy_video_heading` — video title/heading

---

## 2. Auto-Queue Logic

**Location:** `auto-trader/src/scheduler.ts`

### Daily Signals (`autoQueueDailySignalsFromTrackedVideos`)

- Filters videos: `strategyType === 'daily_signal'`, `tradeDate` = today ET, `extractedSignals` present
- For each `extractedSignals` entry:
  - `longTriggerAbove` + `longTargets` → BUY signal (confidence 8)
  - `shortTriggerBelow` + `shortTargets` → SELL signal (confidence 8)
- Deduplicates by `sourceName + ticker + signal + mode + executeOnDate + strategyVideoId`

### Generic Signals (`autoQueueGenericSignalsFromTrackedVideos`)

- Filters videos: `strategyType === 'generic_strategy'`
- For each scanner idea (confidence ≥ `minScannerConfidence`), creates one signal per video bucket (one ticker can be queued for multiple strategies)
- Skips tickers with active trades
- Deduplicates per signal

---

## 3. Execution Pipeline

**Flow:**

1. `runSchedulerCycle()` → `autoQueueDailySignalsFromTrackedVideos()` → `autoQueueGenericSignalsFromTrackedVideos(allIdeas)` → `processExternalStrategySignals()`
2. `getDueExternalStrategySignals()` returns PENDING signals with `execute_on_date <= today` (ET)
3. For each signal: check execution window, then `executeExternalStrategySignal()`

### Validation for Generic External Signals

When `entry_price` is null (generic strategy):

| Guardrail | Behavior |
|-----------|----------|
| **Confidence threshold** | `faConf < config.minFAConfidence` → SKIPPED |
| **HOLD rejection** | `faRec === 'HOLD'` → SKIPPED |
| **Direction match** | `faRec !== signal.signal` → SKIPPED |

Additional checks: `shouldMarkStrategyX()` (consecutive losses), `runPreTradeChecks()` (allocation cap, sector, earnings), execution window (for First Candle).

---

## 4. Scheduler & Timing

**ET day boundaries:** `getETDateString()` / `formatDateToEtIso()` use `America/New_York`.

**Cron jobs:**

| Schedule | Description |
|----------|-------------|
| `*/30 9-16 * * 1-5` | Main scheduler — every 30 min, 9:00–16:30 ET, weekdays |
| `36 9 * * 1-5` | First Candle — 09:36 ET, weekdays |

**First Candle strategy:**

- `executionWindowEt: { start: "09:35", end: "10:30" }` in `strategy-videos.json`
- `strategyWindowByVideoId` enforces this window
- Outside window → EXPIRED or WAITING

---

## 5. Allocation Logic

**Per-stock multi-strategy allocation** (`processExternalStrategySignals`):

1. Group PENDING generic signals by `ticker::mode::signal::execute_on_date`
2. If group has > 1 signal (same ticker, multiple strategies):
   - `allocationSplit = group.length`
   - `allocationIndex = 1..n` per signal
   - `allowDuplicateTicker = true`
3. `executeExternalStrategySignal()`:
   - `splitDollarSize = baseSizing.dollarSize / allocationSplit`
   - `splitQuantity = Math.floor(splitDollarSize / referencePrice)`
   - Each strategy gets `1/n` of the base size for that ticker

**Purpose:** Compare strategies on the same underlying with equal allocation.

---

## 6. Strategy Performance UI

**Location:** Paper Trading → **Strategies** tab (`tab === 'strategies'`)

**Components:**

- `StrategyPerformanceTab` in `app/src/components/PaperTrading.tsx`
- Data: `recalculatePerformanceByStrategyVideo()`, `getStrategySignalStatusSummaries()` in `app/src/lib/paperTradesApi.ts`

**Source leaderboard:** Source, Trades, Win Rate, Avg P&L, Total P&L, Videos — expand/collapse per source.

**Drill-down by video:** Per-video rows with columns: Strategy (heading), Date, Trade Count, Trade 1–3 samples, Win Rate, Avg %, Total P&L, Status. Video links: `https://www.instagram.com/reel/{videoId}/`.

**Tracked videos:** `strategy-videos.json` merged into `getStrategySignalStatusSummaries()` for videos with no trades yet.

---

## 7. Scanner vs Suggested Finds

| Universe | Purpose | Source |
|----------|---------|--------|
| **Swing scanner** | `buildDynamicSwingUniverse()` — core stocks, sector ETFs, Yahoo movers, earnings, portfolio | `supabase/functions/trade-scanner/index.ts` |
| **Suggested Finds** | Long-term Quiet Compounders / Gold Mines | `daily-suggestions` edge function, HuggingFace |

Suggested Finds are **not** part of the swing scanner universe.

---

## 8. Data Models

### Strategy Video Record (`strategy-videos.json`)

```typescript
interface StrategyVideoRecord {
  videoId: string;
  sourceHandle?: string;
  sourceName?: string;
  reelUrl?: string;
  canonicalUrl?: string;
  videoHeading?: string;
  strategyType?: 'daily_signal' | 'generic_strategy';
  timeframe?: 'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM';
  applicableTimeframes?: Array<'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM'>;
  executionWindowEt?: { start?: string; end?: string };
  tradeDate?: string;
  extractedSignals?: DailyVideoSignal[];
}
```

### External Strategy Signal

```typescript
interface ExternalStrategySignal {
  id: string;
  source_name: string;
  source_url: string | null;
  strategy_video_id: string | null;
  strategy_video_heading: string | null;
  ticker: string;
  signal: 'BUY' | 'SELL';
  mode: 'DAY_TRADE' | 'SWING_TRADE' | 'LONG_TERM';
  confidence: number;
  entry_price: number | null;
  stop_loss: number | null;
  target_price: number | null;
  execute_on_date: string;
  status: 'PENDING' | 'EXECUTED' | 'FAILED' | 'SKIPPED' | 'EXPIRED' | 'CANCELLED';
  // ...
}
```

### Paper Trade (with strategy attribution)

```typescript
interface PaperTrade {
  strategy_source: string | null;
  strategy_source_url: string | null;
  strategy_video_id: string | null;
  strategy_video_heading: string | null;
  // ... mode, signal, pnl, etc.
}
```

---

## Key File Reference

| Concern | Primary Files |
|---------|---------------|
| Scheduler & queue | `auto-trader/src/scheduler.ts` |
| External signals CRUD | `auto-trader/src/lib/supabase.ts` |
| Strategy performance API | `app/src/lib/paperTradesApi.ts` |
| Strategy Performance UI | `app/src/components/PaperTrading.tsx` (StrategyPerformanceTab) |
| Strategy video config | `auto-trader/strategy-videos.json`, `app/public/strategy-videos.json` |
| Swing universe | `supabase/functions/trade-scanner/index.ts` (buildDynamicSwingUniverse) |
| Migrations | `supabase/migrations/20260219000001_external_strategy_signals.sql`, `20260219000002_strategy_video_metadata.sql` |

---

## Related Docs

- [WORKLOG-2026-02-19.md](./WORKLOG-2026-02-19.md) — Implementation log and commits
- [auto-trader/SMART_TRADING_PLAN.md](../auto-trader/SMART_TRADING_PLAN.md) — Trading system overview, data flow, scheduler API
