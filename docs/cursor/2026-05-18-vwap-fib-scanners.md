# VWAP Confluence & Fibonacci Retracement Scanners

**Date:** 2026-05-18
**Goal:** Add two deterministic DAY_TRADE scanner strategies to the auto-trader.

## Architecture

Four new files in `auto-trader/src/lib/`:

### 1. `session-levels.ts` — Pre-market / RTH levels helper

- Fetches 1m bars from Yahoo Finance with `includePrePost=true`
- Splits bars at 9:30 AM ET boundary → pre-market high/low + RTH high/low
- In-memory cache per ticker, 5-min TTL, resets daily at midnight ET
- Used by both scanners for target price (PM high) and stop placement

### 2. `intraday-indicators.ts` — EMA & ATR on 5m bars

- `computeEMA(closes, period)` → full EMA series (SMA-seeded, oldest-first)
- `computeEMALatest(closes, period)` → single latest EMA value
- `computeATR(bars, period)` → Wilder-smoothed ATR from OHLC bars
- Pure functions, no side effects or API calls

### 3. `vwap-confluence-scanner.ts` — VWAP + 200 SMA + EMA 8/21 confluence

**State machine:** idle → zone_detected → triggered → done (per ticker, daily reset)

**Logic:**
1. Scans 25-ticker universe (mega-cap tech, liquid ETFs) on 5m bars
2. Computes VWAP (session-anchored), EMA 8, EMA 21 from 5m closes
3. Fetches SMA 200 from Yahoo quote `twoHundredDayAverage`
4. Confluence = all 4 levels within 0.35% of their median
5. Entry trigger: prior bar touched zone + current bar closes above VWAP
6. Stop: zone minimum - buffer (max of 0.1% price or 0.3 ATR)
7. Target: pre-market high (falls back to 1.5× risk if PMH ≤ entry)

**Confidence scoring (base 6):**
- +1 tight spread (<0.25%)
- +1 active session (≥20 bars)
- +1 close > EMA8 > EMA21
- +1 R:R ≥ 2.0
- Minimum 7 to emit

**executeScannerTrade modifications:**
- Skips ORB chop gate (strategy IS a chop-exit play)
- Skips VWAP alignment +0.3 modifier (avoids double-counting)

### 4. `fib-retrace-scanner.ts` — Fibonacci 0.236 retracement rejection

**State machine:** idle → triggered → done (per ticker, daily reset)

**Logic:**
1. Same 25-ticker universe
2. Detects intraday trend from last 12 bars (~1h): close vs EMA21, higher-low / lower-high ratios
3. Computes Fibonacci levels from swing high/low
4. Entry trigger: candle wicks into 0.236 level zone (within tolerance) and closes back on trend side
5. Long in uptrends (bounce off support), short in downtrends (rejection at resistance)
6. Stop: beyond 0.382 level - buffer
7. Target: pre-market high (long) or pre-market low (short)

**Confidence scoring (base 6):**
- +1 clear trend (≥60% HL/LH ratio)
- +1 volume on rejection bar (>1.2× avg)
- +1 R:R ≥ 2.0
- +1 PMH/PML alignment
- Minimum 7 to emit

**executeScannerTrade:** All existing gates apply (ORB, VWAP modifier, trend filter).

## Scheduler Integration

Both scanners are called in the main 15-min cycle after the SPX level scanner:

```
if (isModeEnabled(config, 'DAY_TRADE')) {
  checkVwapConfluenceSetups(...)   // 12a-ii
  checkFibRetraceSetups(...)       // 12a-iii
}
```

Each scanner receives an `executeTrade` callback that:
1. Builds a `TradeIdea` with appropriate tags (`vwap_confluence` or `fib_236`)
2. Checks `hasActiveTrade` and `isDayTradeLossGateActive`
3. Calls `executeScannerTrade` and logs via `persistEvent`

## Key Decisions

- **Yahoo Finance only** — no Finnhub/AI calls. Deterministic, rule-based.
- **25-ticker universe** — balances coverage vs API rate limits. 5 tickers/batch with 1s delay.
- **3-min bar cache** — shared across scanners within a cycle to avoid redundant fetches.
- **Tag-based gate skips** — `vwap_confluence` skips ORB and VWAP modifier; `fib_236` keeps all gates.
- **Time gate 10 AM – 3:30 PM ET** — VWAP needs volume to stabilize; avoids EOD chop.
