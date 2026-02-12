# Trade Ideas — AI Scanner (v3)

> Cursor agent plan — implemented and shipped

## Overview

AI-powered trade idea suggestions that scan the market for high-confidence day and swing trade setups. Uses a two-pass architecture: fast Yahoo Finance screening → Gemini AI batch evaluation with candle validation. Results are cached in Supabase DB and shared across all users.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    trade-scanner (v3)                     │
│                                                          │
│  PASS 1 — Quick filter (indicators only)                 │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────┐  │
│  │ Yahoo Finance │───▶│ Enrich with  │───▶│ Gemini AI │  │
│  │  Screener     │    │ RSI/MACD/SMA │    │ Batch eval│  │
│  │ (gainers +    │    │ ATR (daily)  │    │ → top 8   │  │
│  │  losers)      │    │              │    │           │  │
│  └──────────────┘    └──────────────┘    └─────┬─────┘  │
│                                                 │        │
│  PASS 2 — Refine with candle data               │        │
│  ┌──────────────┐    ┌──────────────────────────┴─────┐  │
│  │ Yahoo v8     │───▶│ Gemini AI re-evaluate          │  │
│  │ 5m + 15m     │    │ with SAME rules as full        │  │
│  │ candles      │    │ analysis (shared prompts)      │  │
│  │ (top 8 only) │    │ → final 5-6 picks              │  │
│  └──────────────┘    └──────────────────────────┬─────┘  │
│                                                 │        │
│  ┌──────────────────────────────────────────────┴─────┐  │
│  │ Supabase DB (trade_scans table)                    │  │
│  │ Day: 30 min TTL | Swing: 6 hr TTL                 │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Shared Prompts — Single Source of Truth

Both the scanner (`trade-scanner`) and full analysis (`trading-signals`) use the **exact same** AI rules from `supabase/functions/_shared/prompts.ts`:

- `DAY_TRADE_SYSTEM` — Day trade persona
- `DAY_TRADE_RULES` — All day trade rules (RSI, MACD, volume, S/R, liquidity grabs, etc.)
- `SWING_TRADE_SYSTEM` — Swing trade persona
- `SWING_TRADE_RULES` — All swing trade rules (don't chase, SMA trend, gaps, earnings, etc.)

**To update a rule:** Edit `_shared/prompts.ts` → deploy both functions → scanner and full analysis stay consistent.

## Data Flow

### Day Trades (refreshed every 30 min during market hours)

1. **Discovery**: Yahoo screener → top 15 gainers + losers (filtered: price > $3, change > 3%, volume > 500K)
2. **Enrichment**: Yahoo v8 chart API (1y daily) → compute RSI, MACD, SMA20/50/200, ATR
3. **Pass 1**: Gemini batch evaluation on indicators → top 8 candidates (confidence >= 6)
4. **Pass 2**: Fetch 5m + 15m candles for top 8 → Gemini re-evaluates with candle data → final picks (confidence >= 7)
5. **Cache**: Write to `trade_scans` table, 30 min TTL

### Swing Trades (refreshed 2x/day: ~10AM + ~3:45PM ET)

1. **Discovery**: Curated universe of ~50 stocks + user's portfolio tickers
2. **Enrichment**: Yahoo v8 chart API (1y daily) → compute indicators
3. **Pass 1**: Gemini batch evaluation → top 8 candidates (confidence >= 5)
4. **Pass 2**: Fetch 3mo daily candles for top 8 → Gemini re-evaluates → final picks (confidence >= 6)
5. **Cache**: Write to `trade_scans` table, 6 hr TTL

## Files

| File | Purpose |
|---|---|
| `supabase/functions/_shared/prompts.ts` | **Shared AI prompts** — single source of truth for rules |
| `supabase/functions/trade-scanner/index.ts` | Edge function: two-pass scanner, Yahoo data, Gemini AI, DB cache |
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
      "tags": ["momentum", "high-volume"],
      "mode": "DAY_TRADE"
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
