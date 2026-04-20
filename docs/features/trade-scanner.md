# Trade Ideas — AI Scanner (v4)

> Cursor agent plan — implemented and shipped

## Overview

AI-powered trade idea suggestions that find high-confidence day and swing trade setups. Uses a **dual-track architecture** for day trades: a proactive key-level track (always runs, even on flat days) plus a reactive mover track (catches momentum plays). Results are cached in Supabase DB and shared across all users.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      trade-scanner (v4)                          │
│                                                                  │
│  TRACK 1 — Key Level Setups (proactive — runs every day)        │
│  ┌─────────────────────┐    ┌──────────────────────────────┐    │
│  │ Key Level Scanner   │───▶│ Gemini/Groq AI               │    │
│  │ SOMESH_WATCHLIST    │    │ "Which direction has edge?"  │    │
│  │ SPY QQQ TSLA NVDA   │    │ Uses pre-computed levels     │    │
│  │ PLTR AMD AAPL etc   │    │ → entry/stop/target set      │    │
│  │ (always evaluated)  │    │   by price structure, not AI │    │
│  └─────────────────────┘    └──────────────────────────────┘    │
│                                                                  │
│  TRACK 2 — Mover Setups (reactive — current movers only)        │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────────────┐  │
│  │ Yahoo Finance │───▶│ Enrich with  │───▶│ Gemini AI         │  │
│  │  Screener     │    │ RSI/MACD/SMA │    │ Pass 1 batch eval │  │
│  │ (gainers +    │    │ ATR (daily)  │    │ → top 8           │  │
│  │  losers +     │    │              │    │                   │  │
│  │  DAY_CORE)    │    │              │    │                   │  │
│  └──────────────┘    └──────────────┘    └────────┬──────────┘  │
│                                                    │             │
│  PASS 2 — Refine with candle data                  │             │
│  ┌──────────────┐    ┌───────────────────────────┴──────────┐   │
│  │ Yahoo v8     │───▶│ Gemini AI re-evaluate                │   │
│  │ 5m + 15m     │    │ with SAME rules as full analysis     │   │
│  │ candles      │    │ → final picks                        │   │
│  │ (top 8 only) │    │                                      │   │
│  └──────────────┘    └──────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Supabase DB (trade_scans table)                          │   │
│  │ Day: 30 min TTL | Swing: 6 hr TTL                       │   │
│  │ Never overwrites non-empty results with empty array      │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Shared Prompts — Single Source of Truth

Both the scanner (`trade-scanner`) and full analysis (`trading-signals`) use the **exact same** AI rules from `supabase/functions/_shared/prompts.ts`:

- `DAY_TRADE_SYSTEM` — Day trade persona
- `DAY_TRADE_RULES` — All day trade rules (RSI, MACD, volume, S/R, liquidity grabs, etc.)
- `SWING_TRADE_SYSTEM` — Swing trade persona
- `SWING_TRADE_RULES` — All swing trade rules (don't chase, SMA trend, gaps, earnings, etc.)
- `TRACK1_SYSTEM` — Key level evaluation persona (Track 1 only, in `trade-scanner/index.ts`)

**To update a rule:** Edit `_shared/prompts.ts` → deploy both functions → scanner and full analysis stay consistent.

## SOMESH_WATCHLIST — Core Watchlist

```typescript
const SOMESH_WATCHLIST = ['SPY', 'QQQ', 'TSLA', 'NVDA', 'PLTR', 'AMD', 'AAPL', 'META', 'MSFT', 'IWM'];
```

These tickers are **always evaluated every day** regardless of whether they're moving. They mirror the core watchlist that Somesh (Kay Capitals) uses. They:
1. **Bypass InPlayScore cutoff** — re-injected into candidates after the top-30 slice
2. **Always included in Track 1** — key level setups computed and AI-evaluated every morning
3. **No `|change| ≥ 1%` requirement** — evaluated even on flat market days

## Data Flow

### Day Trades (refreshed every 30 min during market hours)

**Track 1 — Key Level Setups (runs after Track 2, every day):**
1. Key Level Scanner identifies resistance/support levels for `SOMESH_WATCHLIST` + any ticker within 1.5×ATR of a trigger
2. AI (Gemini/Groq fallback) evaluates each setup: *"Which direction has the edge today?"*
3. Entry, stop, and target are **pre-computed from pure price structure** (no AI guessing levels)
4. Ideas tagged `key-level` + `watchlist` and merged into the day's results
5. Produces signals even on flat days — as long as a ticker is near a key level

**Track 2 — Mover Setups (reactive):**
1. **Discovery**: Yahoo screener (gainers + losers) → pre-filter → dedupe
2. **Enrichment**: Yahoo v8 chart API (1y daily) → compute RSI, MACD, SMA20/50/200, ATR for **all** deduped candidates
3. **Ranking** (large-cap mode): InPlayScore (volRatio, dollarVol, atrPct, trendScore, extensionPenalty) → top 30. SOMESH_WATCHLIST tickers re-injected if cut.
4. **Pass 1**: Gemini batch evaluation on indicators → top 8 candidates (confidence ≥ 5)
5. **Pass 2**: Fetch 5m + 15m candles for top 8 → Gemini re-evaluates with candle data → final picks (confidence ≥ 6)
6. **Cache**: Write to `trade_scans` table, 30 min TTL. **Never overwrites non-empty results with an empty array — previous scan preserved on quiet days.**

**Pre-filter thresholds (Track 2):** Large-cap: price ≥ $20, |change| ≥ 1%, volume ≥ 1M. SOMESH_WATCHLIST: price ≥ $10, volume ≥ 1M (no change% gate).

---

## Day vs Swing — How Picks Differ

| Aspect | Day Trade | Swing Trade |
|--------|-----------|-------------|
| **Discovery** | Track 1 (key levels, always) + Track 2 Yahoo screener (reactive movers) | Curated universe (core + sector momentum + movers + earnings + portfolio) — proactive, stable |
| **Pre-filter** | Track 2: price, \|change%\|, volume. Track 1: SOMESH_WATCHLIST always; others within 1.5×ATR of level | Price ≥ $5 only |
| **Core watchlist** | `SOMESH_WATCHLIST` always evaluated regardless of daily move | `SWING_CORE` — 20 blue chips always included |
| **Ranking before Pass 1** | InPlayScore (large-cap); SOMESH_WATCHLIST re-injected after cut | SwingSetupScore → top 30 |
| **Pass 1 threshold** | Confidence ≥ 5 → top 8 | Confidence ≥ 5 → top 10 |
| **Pass 2 candles** | 15m candles (intraday structure) | Daily Yahoo OHLCV (reused from enrichment) |
| **Pass 2 confidence** | ≥ 6 (day); Track 1 ≥ 6 | ≥ 7, fallback 6 if none |
| **Empty result handling** | Previous scan preserved if new scan yields 0 ideas | Previous scan preserved if new scan yields 0 ideas |

### Swing Trades (refreshed 2x/day: ~10AM + ~3:45PM ET)

1. **Discovery**: `buildDynamicSwingUniverse` — curated, NOT a screener:
   - **Core**: ~20 blue chips (AAPL, MSFT, NVDA, etc.) — always included
   - **Sector momentum**: Top 2–3 sector ETFs by 5-day performance → add 4 stocks each from hot sectors
   - **Yahoo movers**: most_actives + day_gainers + day_losers filtered (price ≥ $10, vol ≥ 1M, volRatio ≥ 1.5x, |change| ≥ 2%) → up to 15
   - **Earnings plays**: Stocks with earnings 5–14 days out (from core + sector universe)
   - **Portfolio**: User's holdings — always included
   - Result: ~35–55 unique tickers
2. **Pre-filter**: `preSwingFilter` — price ≥ $5, has symbol (no volume/change thresholds)
3. **Enrichment**: Yahoo v8 chart API (1y daily) → compute RSI, MACD, SMA, ATR for all
4. **SwingSetupScore pre-ranking**: trendScore + pullbackScore − extensionPenalty → sort desc → top 30
5. **Pass 1**: Gemini batch evaluation on top 30 → confidence >= 5 → top 8
6. **Pass 2**: Reuse daily Yahoo OHLCV (from enrichment) for top 8 → Gemini re-evaluates → final picks (confidence >= 7, fallback 6)
7. **Cache**: Write to `trade_scans` table, 6 hr TTL

## Files

| File | Purpose |
|---|---|
| `supabase/functions/_shared/prompts.ts` | **Shared AI prompts** — single source of truth for rules |
| `supabase/functions/trade-scanner/index.ts` | Edge function: Track 1 key-level scan + Track 2 two-pass mover scan, Yahoo data, InPlayScore, Gemini/Groq AI, DB cache |
| `supabase/functions/trade-scanner/inPlayScore.test.ts` | Unit-test examples for InPlayScore (6-ticker mock) |
| `supabase/functions/trading-signals/index.ts` | Edge function: full analysis (imports same shared prompts) |
| `app/src/lib/tradeScannerApi.ts` | Frontend API client for trade-scanner |
| `app/src/components/TradeIdeas.tsx` | React component: collapsed pills, expanded cards, caution banner |
| `supabase/migrations/20260212000001_trade_scans.sql` | DB migration: `trade_scans` table with RLS |

## API

### `POST /functions/v1/trade-scanner`

**Request:**
```json
{
  "portfolioTickers": ["AAPL", "TSLA"],  // optional
  "forceRefresh": true                     // optional, bypasses cache
}
```

**Response:**
```json
{
  "dayTrades": [
    {
      "ticker": "CROX",
      "name": "Crocs Inc",
      "price": 128.50,
      "change": 22.80,
      "changePercent": 21.6,
      "signal": "BUY",
      "confidence": 7,
      "reason": "Strong gap up with bullish MACD and consistent higher lows on 5m candles",
      "tags": ["key-level", "watchlist"],  // Track 1 ideas tagged key-level + watchlist; Track 2 tagged momentum / high-volume / etc.
      "mode": "DAY_TRADE",
      "entryPrice": 548.55,   // pre-computed trigger level (Track 1) or AI-derived (Track 2)
      "stopLoss": 545.40,
      "targetPrice": 555.00
    }
  ],
  "swingTrades": [],
  "timestamp": 1739384400000,
  "cached": false
}
```

## Gemini Key Rotation

Both functions dynamically collect keys from env vars: `GEMINI_API_KEY`, `GEMINI_API_KEY_2`, ..., `GEMINI_API_KEY_5`. Round-robin rotation across 3 models (`gemini-2.0-flash-lite`, `gemini-2.0-flash`, `gemini-2.5-flash`) with per-combo rate-limit cooldown tracking.

## Frontend

- **Collapsed view**: Horizontal ticker pills with BUY/SELL badge + confidence ring
- **Expanded view**: Day/Swing tabs, idea cards with AI reason, caution banner
- **Click a card**: Populates ticker + mode in the full analysis form (does NOT auto-run)
- **Client-side cache**: 5 min TTL (DB handles longer-term caching)
