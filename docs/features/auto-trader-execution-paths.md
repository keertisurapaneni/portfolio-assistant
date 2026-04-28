# Auto-Trader Execution Paths

**Date:** 2026-02-23  
**Purpose:** Document the three trade execution paths, what checks each applies, and why — so we don't re-add wrong checks.

---

## Overview

The auto-trader has three distinct trade sources, each with its own appropriate gate logic:

| Source | Function | Mode | FA Check? | Why |
|--------|----------|------|-----------|-----|
| Scanner | `executeScannerTrade` | DAY_TRADE / SWING_TRADE | ✅ Yes | Raw technical signal — needs fundamental validation before risking capital |
| Influencer signals | `executeExternalStrategySignal` | DAY_TRADE / SWING_TRADE | ❌ No | We're testing the influencer strategy as-is; their levels are trusted |
| Suggested Finds | `executeSuggestedFindTrade` | LONG_TERM | ❌ No | Daily AI pipeline already ran full fundamental + macro analysis; swing-trade FA is wrong tool |

---

## Path 1 — Scanner Trades (`executeScannerTrade`)

Scanner signals come from `trade-scanner` edge function (technical momentum). FA validation is the right gate here because scanner signals are raw technicals without fundamental context.

**Gate order:**
1. Time gate: must be ≥ 9:35 AM ET (avoids first-candle volatility; added 2026-04-28)
2. No duplicate active trade for ticker
3. Day trade only: daily max-loss gate active → skip
4. Day trade only: inside ORB (choppy) → skip
5. **Swing trade quality gates** (added 2026-04-28):
   - `market_condition = 'chop'` → skip (regime not trending)
   - `volumeVs10dAvg < 0.3` → skip (< 30% of normal volume, thin tape)
   - `volumeVsPriorPeak < 0.65` AND BUY → skip (Wyckoff "Four More Phase" — new high on declining volume vs prior 20-day peak)
6. Day trade only (after 10 AM): VWAP alignment confidence modifier (±0.3, non-blocking)
7. Candle pattern modifier (±0.5/1.0 confidence, non-blocking)
8. FA fetch → confidence ≥ `minFAConfidence` (default 7)
9. FA recommendation ≠ HOLD
10. FA direction matches signal (BUY/SELL)
11. Entry/stop/target levels present
12. Day trade only: R:R ≥ 1.8
13. `runPreTradeChecks` (drawdown, allocation cap, sector exposure, earnings blackout)
14. IB contract lookup
15. Swing only: current price within 4% of entry level

---

## Path 2 — Influencer Strategy Signals (`executeExternalStrategySignal`)

Signals imported from strategy videos (`import-strategy-signals` edge function). The influencer already provided entry/stop/target levels and direction. Running FA on top defeats the purpose of testing the strategy.

**FA is bypassed when `signal.strategy_video_id != null`** (all signals from `import-strategy-signals` have this set).

**Gate order:**
1. Strategy-X check — block if source has ≥ N consecutive losses (configurable)
2. No duplicate active trade (with special handling for same-video multi-ticker allocation)
3. FA validation — **only** for signals without `strategy_video_id` AND without provided levels
4. Price/trigger logic — waits if price hasn't reached entry level yet
5. Position sizing (split by allocation group for generic strategies)
6. `runPreTradeChecks` (drawdown, allocation cap, sector exposure, earnings blackout)
7. IB contract lookup
8. Swing only: current price within 4% of entry level

---

## Path 3 — Suggested Finds (`executeSuggestedFindTrade`)

Suggested Finds are generated daily by the AI pipeline: HuggingFace candidates → Finnhub fundamentals → AI analysis → conviction scoring. That IS the full analysis. Running `trading-signals` FA on top is wrong because:
- FA uses short-term swing trade signals (momentum, technicals)
- Suggested Finds conviction is long-term fundamental + macro thesis
- Comparing them directly caused good picks (e.g. NEM conviction 9) to be blocked by swing FA returning 4

**Gate order:**
1. No duplicate active trade for ticker
2. Gold Mine only: SPY < SMA200 blocks entry (bear market macro protection)
3. ~~FA check~~ — **removed** (was wrong tool; AI pipeline is the analysis)
4. Current price from Finnhub
5. Gold Mine 40% allocation cap (`0.40 * maxTotalAllocation`)
6. `runPreTradeChecks` (drawdown, allocation cap, sector exposure, earnings blackout)
7. IB contract lookup

**Pre-filtering** (in `preGenerateSuggestedFinds` before execution):
- Conviction ≥ `minSuggestedFindsConviction`
- Valuation tag: deep value / undervalued, OR top pick with conviction ≥ 8
- Limited to available slots (`maxPositions - activeCount`)

---

## `runPreTradeChecks` (applies to all 3 paths)

```
1. Drawdown protection: block if portfolio P&L ≤ -5% (critical level)
2. checkAllocationCap: deployed < 95% of maxTotalAllocation; daily limit check (ET date)
3. checkSectorExposure: sector concentration ≤ maxSectorPct of portfolio value
4. checkEarningsBlackout: no entry within earningsBlackoutDays of earnings date
```

**Fail-open behavior:** sector lookup and earnings lookup fail open (allow trade) if Finnhub is unreachable.

---

## Key Design Decisions

### Why no FA for influencer signals?
The goal is to test "does following this influencer's levels make money?" Adding our own FA override corrupts the backtest — if we skip a trade because FA disagrees and the influencer was right, we can't measure the strategy's true performance.

### Why no FA for Suggested Finds?
Suggested Finds already runs a 4-step AI pipeline with Finnhub fundamentals. The `trading-signals` FA is a swing trade tool that returns momentum-based confidence, not long-term fundamental conviction. Using it to gate a long-term pick is apples-to-oranges.

### Why FA for scanner?
Scanner signals are purely technical (RSI, MACD, volume patterns). They have no fundamental context. FA provides a second opinion and filters out technically-attractive but fundamentally-weak setups.

---

## Known Remaining Issues (non-critical)

| Issue | Impact | Priority |
|-------|--------|----------|
| LONG_TERM external signals (if manually created) bypass Gold Mine 40% cap and SPY<SMA200 check | Low — no such signals exist currently; all strategy video imports are DAY_TRADE | Low |
| `isGenericAutoSignal` detected via `notes.includes('generic strategy auto')` string — fragile | Medium — would break if notes format changes | Medium |
| Sector exposure check doesn't include `_pendingDeployedDollar` | Low — 1.5s delay between signals limits window | Low |
| Hardcoded values: 4% swing distance, 40% Gold Mine cap, 95% circuit breaker, 1.8 R:R | Low — sensible defaults; could make configurable | Low |

---

## Position Sizing

`calculatePositionSize` in `scheduler.ts` — priority order:

1. **LONG_TERM + conviction** → `alloc × base_allocation_pct × convictionMultiplier(conviction)` (× 0.75 for Gold Mine)
2. **With entry + stop levels** → risk-based: `(alloc × risk_per_trade_pct) / riskPerShare × price`
3. **Fallback (no levels)** → `alloc × base_allocation_pct` — applies to **all modes** (day/swing/long-term)

All paths then apply `× regimeMultiplier × drawdownMultiplier`, capped at `min(portfolioValue × maxPositionPct, alloc × 10%)`.

**Key sizing lever: `Base Allocation %` in Settings.** At `maxTotalAllocation = $500K`:

| Base Alloc % | Per trade (no drawdown) | After 0.75× drawdown caution |
|---|---|---|
| 2% | $10,000 | $7,500 |
| 4% | $20,000 | $15,000 |
| 8% | $40,000 | $30,000 |
| 10% | $50,000 | $37,500 |

**Also check `Daily Deployment Limit`** — if running 3–5 day trades at 5%+ each, the daily cap can be hit before all signals execute.

---

## PRs that established this architecture

| PR | Change |
|----|--------|
| #57 | Bypass FA for influencer strategy signals (`strategy_video_id != null`) |
| #59 | Remove `conviction_drop` check for Suggested Finds (wrong metric) |
| #60 | Remove remaining FA check for Suggested Finds (wrong tool entirely) |
| #61 | Fix daily deployment limit using ET date instead of UTC |
| #62 | Fix position sizing fallback to use `base_allocation_pct` for day/swing trades |
