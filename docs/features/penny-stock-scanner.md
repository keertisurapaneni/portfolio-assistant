# Penny Stock Momentum Scanner (DAY_PENNY)

> Design doc — Ross Cameron's momentum strategy adapted for the auto-trader

## Overview

A dedicated penny stock momentum scanner that identifies low-float, high-momentum stocks using Ross Cameron's mechanical rules. Runs as a separate pipeline alongside the existing large-cap scanner, with its own discovery, entry confirmation, exit monitoring, position sizing, and P&L tracking.

**Key principle:** This is a paper account experiment. Build with execution from day one, learn from real fills, tune from real data.

## Strategy Rules (Source: Ross Cameron / Warrior Trading)

### Stock Selection — "5 Pillars"

| # | Criterion | Threshold | Automatable? |
|---|-----------|-----------|:------------:|
| 1 | Price range | $2–$20 (sweet spot $2–$10) | Yes |
| 2 | Float | < 10M shares | Yes |
| 3 | Daily gain | ≥ 25% | Yes |
| 4 | News catalyst | Breaking news within 2 hours | Partial (AI) |
| 5 | Relative volume | ≥ 5x vs 20-day average | Yes |
| 6 | Visibility | Top 3 leading % gainers | Yes |

### Entry Rules

- Wait for first pullback after initial surge (1–2 red candles)
- Entry: first green candle making new high vs prior candle high
- Stop loss: low of the pullback
- Target: retest of high of day (minimum 2:1 R:R)
- **Both MACD and volume must confirm** — if either says no, skip
- MACD must be positive (blue line above orange line)
- Volume: green candle volume must exceed red candle volume
- Trade only 1st and 2nd pullbacks, skip 3rd+

### Exit Indicators (any one triggers exit)

1. High volume red candle
2. MACD crossover to negative
3. Topping tail / doji candle
4. Price breaks below VWAP
5. Price breaks below 9 EMA
6. Level 2: big seller / burst of red on time & sales (**human only — not automatable**)

### Risk Management

- First trade of day: half size
- If first trade wins → full size on next trade
- If first trade loses → stay at half size
- 3 consecutive losses = done for the day
- Give back half of daily profit = walk away
- Max daily loss cap (configurable, default -$200)
- Max daily trades cap (configurable, default 10)

### Time Window

- Active: 7:00–10:00 AM ET (pre-market + first 30 min of regular session)
- Pre-market (7:00–9:30) has no circuit breaker halts — cleaner price action
- Regular hours halts (LULD): 10% bands for stocks > $3, 20% bands for $0.75–$3

### Moving Averages

- 9 EMA (primary trend on 1-min chart)
- 20 EMA (secondary)
- 200 EMA (long-term context)
- VWAP (intraday support/resistance)

## Architecture

### Where It Lives

The penny scanner fits into the existing trade signals pipeline as a new category:

```
┌──────────────────── trade_scans table ────────────────────┐
│                                                            │
│  id: 'day_trades'    ← existing large-cap day trades       │
│  id: 'swing_trades'  ← existing swing trades               │
│  id: 'penny_trades'  ← NEW: penny momentum candidates      │
│                                                            │
└────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────── Trade Ideas UI (TradeIdeas.tsx) ───────────┐
│                                                            │
│  [Day Trades]  [Swing Trades]  [Key Levels]  [Penny ★]    │
│   (amber)       (blue)          (violet)      (NEW tab)    │
│                                                            │
└────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────── auto-trader (scheduler.ts) ────────────────┐
│                                                            │
│  subscribeToTradeScans() ← Realtime on trade_scans         │
│       │                                                    │
│       ├── executeScannerTrade()   ← existing (large-cap)   │
│       └── executePennyTrade()    ← NEW (penny rules)       │
│                                                            │
└────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────── paper_trades ──────────────────────────────┐
│                                                            │
│  mode: 'DAY_TRADE'   ← existing                           │
│  mode: 'SWING_TRADE' ← existing                           │
│  mode: 'DAY_PENNY'   ← NEW: separate P&L tracking         │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### Discovery Pipeline

Two options (decide during implementation):

**Option A: Edge function** — Add penny scan type to `trade-scanner`. Reuses Yahoo screener + Supabase cache. Simpler but limited to edge function's refresh cycle.

**Option B: Local scanner** — New `auto-trader/src/lib/penny-scanner.ts` with `setInterval` polling every 30 seconds during 7–10 AM. Faster but bypasses the edge function pattern.

**Recommendation:** Start with Option A (edge function) for discovery since it reuses existing Yahoo screener infra. Entry confirmation and exit monitoring run locally in the auto-trader regardless, since they need 1-min candle analysis and fast IB execution.

### Execution Pipeline

New `executePennyTrade()` in `scheduler.ts` — parallel to `executeScannerTrade()` with penny-specific gates:

- **Skip:** FA alignment, ORB/VWAP reclaim, chop filter, ticker win-rate gate
- **Keep:** duplicate entry prevention, max positions cap, daily loss gate
- **Add:** MACD confirmation on 1-min candles, volume confirmation, pullback pattern detection, R:R validation (≥ 2:1)
- **Position sizing:** fixed dollar amount (default $200/trade), half-size first trade, streak-based scaling

### Exit Monitoring

Runs alongside existing position management loop. For open `DAY_PENNY` positions:

- Poll 1-min candles every 1–2 minutes
- Check exit indicators: MACD crossover, 9 EMA break, VWAP break, volume spike, topping tail
- Hard close all penny positions by 10:00 AM ET (or configurable end time)
- Never hold penny positions overnight

## Data Sources

| Data | Source | Rate Limit |
|------|--------|------------|
| Gainers / price / volume | Yahoo Finance screener | No key required |
| 1-min candles | Yahoo v8 chart API | No key required |
| Float / shares outstanding | Finnhub `/stock/profile2` or `/stock/metric` | 60 calls/min |
| News catalyst | Finnhub `/company-news` | 60 calls/min (shared) |
| Relative volume | Yahoo daily bars (20-day avg) | No key required |

**API budget per scan:** ~20 Finnhub calls at 900ms spacing = 18 seconds. Scanning every 3 min = ~7 calls/min, well within 60/min limit.

## Full Change Map

Complete audit of every file that needs updating for `DAY_PENNY`. Grouped by risk level.

### New Files

| File | Purpose |
|------|---------|
| `auto-trader/src/lib/penny-scanner.ts` | Discovery, entry confirmation, exit monitoring |
| New migration in `supabase/migrations/` | CHECK constraints + `penny_trades` seed row |
| `docs/features/penny-stock-scanner.md` | This doc |

### Layer 1 — Foundation (blocks everything else)

| File | Change | Risk if missed |
|------|--------|----------------|
| `shared/trade-types.ts` | Add `'DAY_PENNY'` to `TradeMode` union | TS errors everywhere |
| `shared/trade-status-sets.ts` | Add `'DAY_PENNY'` to `EQUITY_MODES` | Penny trades vanish from performance edge function |
| Migration: `paper_trades` mode CHECK | Add `'DAY_PENNY'` (latest: `20260423000005`) | DB rejects inserts |
| Migration: `auto_trade_events` mode CHECK | Add `'DAY_PENNY'` (latest: `20260214000006`) | Event logging fails |
| Migration: `trade_performance_log` strategy CHECK | Add `'DAY_PENNY'` (`20260227000001`) | Performance log inserts fail |
| Migration: `trade_scans` seed row | Add `penny_trades` row | No cache slot for penny ideas |

### Layer 2 — Auto-Trader (execution pipeline)

| File | Change | Include/Exclude |
|------|--------|-----------------|
| `auto-trader/src/scheduler.ts` | New `executePennyTrade()` function | New code |
| `auto-trader/src/scheduler.ts` | Active day position filters (lines 610, 718) | INCLUDE — penny counts as active day position |
| `auto-trader/src/scheduler.ts` | EOD soft/hard close queries (`.eq('mode', 'DAY_TRADE')`) | INCLUDE — penny must close EOD too |
| `auto-trader/src/scheduler.ts` | Same-day cooldown queries (line 887, 1143, 1247) | EXCLUDE — penny has own cooldown logic |
| `auto-trader/src/scheduler.ts` | TIF logic (`mode === 'DAY_TRADE' ? 'DAY' : 'GTC'`) (line 3964) | INCLUDE — penny uses DAY TIF |
| `auto-trader/src/scheduler.ts` | Position sizing branches (line 2481, 3273) | EXCLUDE — penny has fixed $ sizing |
| `auto-trader/src/scheduler.ts` | Scan evaluation maps (line 5745, 6005) | INCLUDE — penny ideas get Armed/Blocked badges |
| `auto-trader/src/lib/tradePerformanceLog.ts` | Strategy allow-list (line 161–162) | INCLUDE — or penny P&L log inserts silently skipped |
| `auto-trader/src/lib/supabase.ts` | Mode unions (line 146, 316–330, 439, 596) | INCLUDE where queries should see penny trades |
| `auto-trader/src/routes/strategies.ts` | `VALID_MODES` Set (line 20) | INCLUDE — API accepts penny mode |
| `auto-trader/src/lib/feedback.ts` | Mode check (line 78) | INCLUDE — penny uses same feedback rules |

### Layer 3 — Edge Functions

| File | Change | Include/Exclude |
|------|--------|-----------------|
| `supabase/functions/trade-scanner/index.ts` | Add penny scan type (discovery + write to `penny_trades`) | New code path |
| `supabase/functions/paper-trading-performance/index.ts` | Uses `EQUITY_MODES` (line 198–200) | Automatic via Layer 1 |
| `supabase/functions/trade-performance-log-close/index.ts` | Uses `EQUITY_MODES` + inserts strategy (line 71–98) | Automatic via Layer 1 + migration |
| `supabase/functions/_shared/analysis.ts` | `Mode` union (line 27, 44) | INCLUDE — add `'DAY_PENNY'` to Mode union and interval maps |
| `supabase/functions/trading-signals/index.ts` | `RequestMode` + prompt selection (line 409–440) | INCLUDE — map penny to day trade prompts |
| `supabase/functions/auto-tune-strategy-config/index.ts` | Mode categorization (line 196–208) | New category — don't pollute existing day trade tuning |

### Layer 4 — App UI

| File | Change | Include/Exclude |
|------|--------|-----------------|
| `app/src/components/TradeIdeas.tsx` | New "Penny Stocks" tab + `relevantModes` set (line 144) | New tab |
| `app/src/components/PaperTrading/tabs/TodayActivityTab.tsx` | Filter chip + mode filter (line 267–279) + badge (line 433–436) | New filter + label |
| `app/src/components/PaperTrading/tabs/HistoryTab.tsx` | Mode label (line 188–189, uses `.replace('_', ' ')`) | Works automatically — shows "DAY PENNY" |
| `app/src/components/PaperTrading/tabs/PerformanceTab.tsx` | Strategy breakdown row | Automatic via EQUITY_MODES |
| `app/src/lib/paperTradesApi.ts` | `recalculatePerformanceByCategory` (line 831–881) | New `day_penny` category |
| `app/src/lib/paperTradesApi.ts` | `getDayTradeValidationReport` (line 226) | EXCLUDE — penny gets own report or stays separate |
| `app/src/lib/paperTradesApi.ts` | Influencer patterns (line 1597, 1619) | EXCLUDE — penny isn't influencer-driven |
| `app/src/lib/autoTrader.ts` | Mode branches for TIF, sizing, stale logic (line 523, 630, 714) | INCLUDE — penny follows day trade lifecycle |
| `app/src/lib/aiFeedback.ts` | Mode check (line 122) | INCLUDE |
| `app/src/components/TradingSignals.tsx` | Mode options + throttle keys (line 408, 476, 614) | New mode option |
| `app/src/lib/tradeScannerApi.ts` | Mode union (line 19) | Extend for penny |
| `app/src/lib/tradingSignalsApi.ts` | `SignalsMode` union (line 9) | Extend for penny |
| `app/src/components/PaperTrading/tabs/StrategyPerformanceTab.tsx` | Timeframe union (line 37, 1002) | EXCLUDE — penny isn't a video timeframe |
| `app/src/components/PaperTrading/tabs/ValidationTab.tsx` | Diagnostics section | Optional — separate penny report later |

### Layer 5 — Won't Break But Should Review

| File | Notes |
|------|-------|
| `supabase/functions/extract-strategy-metadata-from-transcript/index.ts` | EXCLUDE — videos aren't tagged as penny timeframe |
| `supabase/functions/import-strategy-signals/index.ts` | EXCLUDE — strategy imports don't target penny |
| `auto-trader/src/lib/tradePerformanceMetrics.test.ts` | Update fixtures if testing penny metrics |
| `.cursor/rules/auto-trader-conventions.mdc` | Document DAY_PENNY in "Trade Modes" section |
| `supabase/functions/README.md` | Document penny scan type |

## Safety Nets

Even on a paper account, enforce these to keep the experiment clean:

1. **`pennyMaxDailyLoss`** — default -$200/day from penny trades
2. **`pennyMaxDailyTrades`** — default 10 trades/day
3. **3 consecutive losses = done** — Cameron's rule, built into session state
4. **Give back 50% of daily peak = done** — protects profitable days
5. **Hard EOD close** — all penny positions closed by configured end time
6. **Process-level circuit breaker** — if penny scanner throws 3 errors in a row, disable and alert

## Success Criteria (30-Day Evaluation)

After 30 days of paper trading:

| Metric | Target | Kill if below |
|--------|--------|---------------|
| Win rate | > 50% | < 35% |
| Avg winner / avg loser | > 1.5:1 | < 1.0:1 |
| Expectancy per trade | > $0 | Negative after 50 trades |
| Max drawdown | < $500 | > $1,000 |
| Trades per day (avg) | 2–5 | 0 (scanner can't find setups) |

## What We Can't Automate

Three aspects of Cameron's strategy that require human discretion:

1. **Level 2 / tape reading** — reading order flow, spotting iceberg orders, momentum shifts in time & sales. This is Cameron's primary edge.
2. **News quality assessment** — distinguishing FDA approval from fluff PR. Gemini can approximate but adds latency.
3. **"Feel" for extended moves** — knowing when a stock has run too far. We proxy with ATR distance thresholds.

## Phase Plan

| Phase | What Ships | Timeline |
|-------|-----------|----------|
| 1 | Types + migration + discovery + entry logic + bracket orders | Days 1–2 |
| 2 | Exit monitoring (MACD/EMA/VWAP/volume exits) + session state (streak tracking) | Day 3 |
| 3 | UI integration (Trade Ideas tab, Today's Activity, Performance category) | Day 4 |
| 4 | Tuning from real paper data | Ongoing |
