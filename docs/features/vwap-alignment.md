# VWAP Alignment Confidence Modifier

> Implemented 2026-04-27 · `auto-trader/src/lib/vwap.ts`

## Overview

VWAP (Volume Weighted Average Price) is a dynamic intraday level that reflects the true average price of a stock, weighted by volume. Institutional desks are benchmarked against VWAP — they buy at or near it (can't justify overpaying) and sell at or near it (won't undercut their exit price). This makes VWAP a reliable dynamic support/resistance level.

The auto-trader uses VWAP as a **confidence modifier** on day trades: when price is near VWAP and the trade direction aligns with institutional flow, confidence is nudged up slightly. It is never a hard gate.

---

## The Rule (Somesh's Framework)

```
BUY  → institutions anchor entries at/near VWAP (buying at average price)
         price far ABOVE VWAP = already expensive, institutions won't push further
         price AT or BELOW VWAP = favorable entry zone

SELL → institutions anchor exits at/near VWAP (selling at average price)
         price far BELOW VWAP = already discounted, institutions won't chase lower
         price AT or ABOVE VWAP = favorable exit zone
```

Entry pattern: price approaches VWAP → bounce/rejection → trade in direction of rejection.
Failed bounce: price tries to hold VWAP, fails, retests → entry on the retest.

**Critical rule: VWAP is only reliable after 10:00 AM ET.** Before that, insufficient session volume exists for institutional anchoring. The modifier is a complete no-op before 10 AM.

---

## VWAP Formula

Session-anchored, computed from 5-min bars starting at 9:30 AM ET:

```
typical_price[i]  = (high[i] + low[i] + close[i]) / 3
cumTPV[i]         = cumTPV[i-1] + typical_price[i] × volume[i]
cumVol[i]         = cumVol[i-1] + volume[i]
VWAP[i]           = cumTPV[i] / cumVol[i]
```

This matches TradingView's VWAP with `Source = HLC/3, Anchor = Session`.

---

## Confidence Modifier Logic

Applied in `executeScannerTrade` for `DAY_TRADE` mode only:

| Condition | Delta | Notes |
|-----------|-------|-------|
| Price within 0.5% of VWAP (any side) | **+0.3** | Near the institutional anchor — best entry zone |
| Price far from VWAP, directionally aligned | 0 | Not at the level yet — neutral |
| Price far from VWAP, directionally misaligned | 0 + warning log | Reduced edge, logged but not blocked |
| Before 10 AM ET | 0 | Hard rule — insufficient session data |
| Data fetch failure | 0 | Non-blocking — trade proceeds normally |

The +0.3 delta is additive to the scanner confidence score (capped at 10). It stacks with the candlestick pattern modifier (+0.5 confirming, -1.0 contradicting).

---

## Implementation

| Component | Detail |
|-----------|--------|
| File | `auto-trader/src/lib/vwap.ts` |
| Data source | Yahoo Finance `range=1d&interval=5m` (same endpoint as ORB) |
| Cache | In-memory, 3-min TTL — shorter than ORB since VWAP drifts throughout the session |
| 10 AM gate | Hard-coded in `evaluateVwapAlignment()`; passes `etHour` from caller |
| Key export | `fetchVwap(symbol)` → `VwapResult \| null` |
| Modifier export | `evaluateVwapAlignment(symbol, direction, etHour)` → `{ delta, log }` |

---

## What's Not Built (Yet)

- **VWAP as an entry signal**: Detecting the price-touches-VWAP → bounce → entry pattern as a standalone trade source (like the SPX level scanner). Deferred until the modifier gives us data on VWAP's real value in practice.
- **VWAP bands**: Standard deviation bands above/below VWAP (Somesh shows these but doesn't use them for entries). Not implemented.
- **Multi-timeframe VWAP**: Weekly or monthly anchored VWAP. Not in scope.

---

## Monitoring

VWAP modifier activity is logged per trade in the scheduler log:
- `${ticker}: VWAP +0.3 confidence → X (price $Y near VWAP $Z (+0.2%))` — when modifier fires
- `${ticker}: VWAP: pre-10AM, skipped` — before 10 AM
- `${ticker}: VWAP: +1.2% from $550.00 — reduced edge, proceeding` — misaligned but non-blocking

Check `auto_trade_events` after 2 weeks to evaluate whether VWAP alignment (`+0.3` modifier fires) correlates with better trade outcomes vs. misaligned entries.
