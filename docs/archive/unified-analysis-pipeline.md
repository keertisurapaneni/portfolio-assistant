# Unified Analysis Pipeline — Scanner + Full Analysis Consistency

**Date:** 2026-02-12
**Goal:** Eliminate BUY vs SELL mismatches between Trade Ideas (scanner) and Full Analysis (FA).

## Problem

The scanner and FA were giving contradictory signals for the same ticker (e.g., ABBV: scanner BUY/7, FA HOLD/4; LSTR: scanner SELL/8, FA BUY/6). Root causes:

1. **Different data sources** — Scanner used Yahoo screener quotes; FA used Twelve Data + Finnhub
2. **Different indicators** — Scanner computed 4 lightweight indicators; FA computed 13 comprehensive ones
3. **Different candle timeframes** — Scanner used daily for everything; FA used 15min (day) / daily (swing)
4. **Different prompt formatting** — Indicator summaries looked completely different

## Solution: Three Shared Pillars

### 1. `_shared/indicators.ts` — Same computation code

Moved the full 13-indicator engine from `trading-signals/indicators.ts` to `_shared/indicators.ts`. Both scanner Pass 2 and FA call `computeAllIndicators()` + `formatIndicatorsForPrompt()`.

### 2. `_shared/prompts.ts` — Same rules and prompt structures

Scanner's `DAY_REFINE_USER` and `SWING_REFINE_USER` prompts use the same `DAY_TRADE_RULES` / `SWING_TRADE_RULES` as FA, just with a simpler output schema (signal/confidence/reason vs full entry/exit/scenarios).

### 3. `_shared/data-fetchers.ts` — Same Yahoo Finance data source

Unified all candle data to Yahoo Finance v8 API. No more Twelve Data for candles. Includes 1h→4h aggregation for swing trades (Yahoo doesn't have native 4h).

## Architecture

```
Scanner Pass 1: Yahoo screener → 4 lightweight indicators → Gemini quick filter
Scanner Pass 2: fetchCandles(15min) or reuse daily OHLCV → computeAllIndicators → formatIndicatorsForPrompt → shared prompts → Gemini
Full Analysis:  prepareAnalysisContext → computeAllIndicators → formatIndicatorsForPrompt → shared prompts → Gemini
```

### Key decision: Don't re-fetch data in scanner Pass 2

Instead of calling `prepareAnalysisContext` (which hit Supabase compute limits with 5+ tickers), the scanner:
- **Day trades:** Fetches only 15min candles (1 API call/ticker) → computes full indicators (matching FA's 15min timeframe)
- **Swing trades:** Reuses daily OHLCV from Pass 1 chart enrichment (zero extra fetches) → identical to FA

## Results

After unification, tested in browser:

| Ticker | Mode | Scanner | Full Analysis | Match? |
|--------|------|---------|---------------|--------|
| ICLR | Day | BUY/7 | BUY/7 | Perfect |
| SPHR | Day | BUY/7 | BUY/8 | Match |
| ABBV | Swing | BUY/7 | HOLD/6 (weak bullish) | Same direction |

No more BUY vs SELL contradictions.

## Trade-offs

- Scanner Pass 1 still uses 4 lightweight indicators (fast filter, not shared code) — acceptable since Pass 2 does full analysis
- `prepareAnalysisContext` in `_shared/analysis.ts` is used by FA but not by scanner (scanner reuses Pass 1 data to avoid compute limits)
- Volume ratio bug fixed: skip in-progress candles with volume=0 from Yahoo

## Files Changed

- `supabase/functions/_shared/indicators.ts` — moved from trading-signals/, bug fix for volume ratio
- `supabase/functions/_shared/analysis.ts` — new shared analysis context (used by FA)
- `supabase/functions/_shared/prompts.ts` — added scanner refine prompts
- `supabase/functions/_shared/data-fetchers.ts` — unified Yahoo Finance data source
- `supabase/functions/trading-signals/index.ts` — refactored to use prepareAnalysisContext
- `supabase/functions/trade-scanner/index.ts` — Pass 2 rewritten with shared indicators
