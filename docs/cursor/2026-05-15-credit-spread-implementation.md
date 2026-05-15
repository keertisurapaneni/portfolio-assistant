# Credit Spread Strategy Implementation

**Date:** 2026-05-15
**Status:** Implemented and running

## Overview

Vertical credit spread support (bull put spreads + bear call spreads) based on Tony Zang/OptionsPlay framework. Capital-efficient defined-risk strategy that enables ~4x more positions than cash-secured puts with same account capital.

## Key Design Decisions

### Strategy Rules (Tony Zang Framework)
- **Entry**: Collect ≥33% of spread width (prefer 40%+ sweet spot)
- **DTE**: Target 45 days (allows time decay to work)
- **Sizing**: Max 2% of account per position (2% risk rule)
- **Timing**: Trend-following with pullback entries (stock above SMA50 + pulled back 3%+ from 20-day high)
- **Direction**: Bull put (bullish trend) or bear call (bearish trend)
- **Earnings**: Skip tickers with earnings within 45 days

### Exit Rules (Mechanical — no discretion)
1. **50% profit take** — buy back when spread decayed to 50% of original credit
2. **100% stop loss** — close when loss equals max gain (lost as much as could've made)
3. **21 DTE time exit** — close regardless of P&L to avoid gamma risk

### Portfolio Limits
- Max 8 concurrent credit spreads
- Max 30% of account in total spread risk (circuit breaker)
- Scans Tue/Thu at 10:30 AM ET (staggered from options wheel)
- Position management every 30 min during market hours

## Architecture

### New Files
- `auto-trader/src/lib/credit-spread-scanner.ts` — scanner + position management
- `supabase/migrations/20260515000001_credit_spreads.sql` — DB schema

### Modified Files
- `auto-trader/src/ib-connection.ts` — `placeVerticalSpreadOrder()` (BAG combo)
- `auto-trader/src/lib/options-chain.ts` — `findSpreadStrikes()` + BS helpers
- `auto-trader/src/scheduler.ts` — cron jobs for scan + management
- `shared/trade-types.ts` — `CREDIT_SPREAD` mode + new close reasons
- `app/src/lib/optionsApi.ts` — API functions for spreads
- `app/src/components/PaperTrading/tabs/OptionsTab.tsx` — Spreads tab + SpreadCard component

### DB Columns Added to `paper_trades`
- `spread_type` — BULL_PUT | BEAR_CALL
- `spread_short_strike` — income leg
- `spread_long_strike` — protection leg
- `spread_width` — abs(short - long)
- `spread_net_credit` — premium collected per share
- `spread_credit_pct` — net_credit / width
- `spread_max_loss` — (width - credit) × 100 × contracts
- `spread_max_gain` — credit × 100 × contracts

## Capital Efficiency Comparison

| Strategy | Capital per Position | Positions with $550k |
|----------|---------------------|---------------------|
| Cash-secured put | ~$15k-50k (full strike × 100) | 11-36 |
| Credit spread | ~$1.5k-5k (width × 100 - credit) | 110-367 |
| Effective multiplier | **~10x** | |

With the 2% risk rule and $550k account = ~$11k max risk per spread → can run 40+ concurrent spreads vs 11 CSPs.
