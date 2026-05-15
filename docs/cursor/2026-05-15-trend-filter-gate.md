# 4H 100 EMA Trend Filter Gate

**Date:** 2026-05-15
**Source:** Trade by Pat — break-and-retest strategy analysis
**Status:** Shipped (PR #241)

## Goal

Improve DAY_TRADE win rate by filtering out entries where the higher-timeframe trend is against the signal direction.

## Baseline (before filter)

- 269 closed DAY_TRADE BUY trades
- **Win rate: 53.5%**
- **Profit factor: 1.17**
- Avg win: $113.11 | Avg loss: -$111.23

## Approach

From Trade by Pat's framework, we extracted the **simplest high-leverage piece**: the 100 EMA trend confirmation on the 4-hour timeframe.

### Gate Logic

For DAY_TRADE BUY signals:
1. Fetch 6 months of 1H candles from Yahoo Finance
2. Synthesize into 4H bars
3. Compute 100-period EMA
4. **Pass conditions (both required):**
   - Current price > 4H 100 EMA
   - EMA slope positive (current vs 5 bars ago)
5. If either fails → skip the trade, log reason

For SELL signals: inverse (price below EMA, slope negative).

### Non-blocking

If Yahoo data is unavailable or insufficient, the filter passes (doesn't block trades).

## What We Didn't Build (yet)

The full Pat strategy includes:
- Higher-high / higher-low trend structure detection
- Support/resistance flip zone identification
- Demand/supply zone detection (consecutive candle pushes)
- Multi-timeframe entry coordination (4H → 1H → 15m → 5m)

These are parked for later. Estimated effort: 800-1100 lines, 3-4x penny scanner complexity. Will revisit after 30 days of trend filter data.

## Config

- `trendFilterEnabled` (default: `true`)
- Toggle in Settings > Risk Management > "4H Trend Filter"

## Files

- `auto-trader/src/lib/trend-filter.ts` — core module
- `auto-trader/src/scheduler.ts` — gate placement (after daily loss gate, before ORB gate)
- `shared/config-defaults.ts` — config field

## Success Criteria

After 2-3 weeks, compare:
- Win rate (target: 58%+, up from 53.5%)
- Profit factor (target: 1.3+, up from 1.17)
- Trades skipped by filter (expect 15-25% rejection rate)
