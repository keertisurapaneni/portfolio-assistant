# Paper Trading Page Performance + ORB Retry Fix

> 2026-05-07

## Goal

1. Fix slow Paper Trading page load times (~15 parallel API requests on every visit)
2. Fix UI discrepancies (incorrect TRADED badges, wrong BUY/SELL labels)
3. Fix auto-trader executing zero day trades on choppy-open days

## Changes

### 1. Paper Trading page performance (`app/src/components/PaperTrading/index.tsx`)

- **Lazy tab loading**: Split monolithic `loadData()` into `loadCoreData()` (header stats, activity log), `loadIBData()` (positions/orders), and `loadTabData(tab)` (fetched on first tab visit). Initial API calls reduced from ~15 to ~6.
- **Module-level page cache**: `_pageCache` persists component state across unmounts with a 2-minute TTL. Navigating back to the page is instant — no re-fetch.
- **Removed `analyzeUnreviewedTrades`** from the render path — it could trigger expensive AI calls + a full page reload on every visit.

### 2. Shared API caching (`app/src/lib/paperTradesApi.ts`)

- `getSharedTrades()` / `getCachedExemptSources()`: Module-level cache + request deduplication for `paper_trades` and `exempt_from_auto_deactivation` sources. Multiple components calling the same data only trigger one Supabase query.
- `clearSharedTradesCache()`: Called by `handleSync` to force a full refresh.

### 3. TRADED badge fix (`app/src/components/TradeIdeas.tsx`)

The scanner page showed "TRADED" for stocks with active positions from previous days. Fixed by filtering `opened_at` against the current date in Eastern Time — only trades opened *today* show the badge.

### 4. BUY/SELL label fix (`app/src/components/PaperTrading/tabs/TodayActivityTab.tsx`)

Portfolio management actions (loss cut, profit take, lt_auto_sell) showed "BUY" because `scanner_signal` was null and the default was "BUY". Added a `SELL_SOURCES` set to correctly infer "SELL" for these events.

### 5. ORB retryable skip fix (`auto-trader/src/scheduler.ts`)

**Root cause of zero day trades**: `_processedTickers` permanently blocked tickers after any skip (except `outside-market-hours`). On a choppy-open day:
1. Cycle #5 (~9:45 AM): 12 tickers hit `inside_orb` with "VWAP reclaim: insufficient bars" (not enough data yet)
2. All 12 permanently marked as processed → never retried
3. Cycles #6–#24+: "all filtered or already processed" — even though stocks broke out of ORB later

**Fix**: Added `isRetryableSkip()` function. Time-dependent conditions (`inside_orb`, `illiquid`, `rr_*`, `price_too_far`, `swing_chop`, `swing_low_volume`, `swing_volume_divergence`) no longer mark tickers as processed. They're re-evaluated every cycle until conditions change or a non-retryable outcome occurs.

## Key Decisions

- **Retryable vs. permanent skips**: Permanent skips (`duplicate`, `recent_loss_cooldown`, `poor_win_rate`, `pre_trade_check`, etc.) still mark tickers as processed since they won't change within the same day. Only market-condition-based skips are retryable.
- **No throttle on retries**: ORB/VWAP caches (5-min / 3-min TTL) naturally prevent redundant API calls. Each cycle gets fresh data, which is what we want.
- **Cancelled column-select optimization**: The architectural refactors already yielded major performance gains; further micro-optimizations carried disproportionate complexity.

## Files Changed

| File | What |
|------|------|
| `app/src/components/PaperTrading/index.tsx` | Lazy loading, page cache, granular data loaders |
| `app/src/lib/paperTradesApi.ts` | Shared trades cache + deduplication |
| `app/src/components/TradeIdeas.tsx` | TRADED badge ET date filtering |
| `app/src/components/PaperTrading/tabs/TodayActivityTab.tsx` | SELL inference for portfolio management events |
| `auto-trader/src/scheduler.ts` | `isRetryableSkip()` + retryable skip prefixes |
| `docs/features/orb-chop-filter.md` | Updated with retryable skip documentation |
