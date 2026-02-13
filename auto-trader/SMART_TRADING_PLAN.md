# Smart Dynamic Trading System

## Overview

Replace flat position sizing ($1K/$5K per trade) with a multi-layer intelligent trading
system that dynamically adjusts position sizes, buys dips, takes profits, avoids earnings
risk, respects sector limits, and adapts sizing based on actual win rate.

Account: $1M paper | Risk profile: Moderate | **Testing budget: $250K over 1 month**

## PRIMARY GOAL: Signal Quality Validation

The auto-trader's #1 job is to **test how good the AI recommendations are**. All
dynamic sizing/management is secondary. The system must produce clear, independent
scorecards for:

- **Suggested Finds (Long Term)** — Are Quiet Compounders & Gold Mine picks performing?
- **Day Trade Signals** — Are scanner + FA day trade signals profitable?
- **Swing Trade Signals** — Are scanner + FA swing trade signals profitable?

Dip-buy/profit-take actions are tracked separately so they don't pollute the
"initial signal quality" metrics. Analysis tracks "did the pick work?" separately
from "did active management add alpha?"

## Allocation Cap

Total deployed capital hard-capped at **$250K**. Before any new trade:
- `totalDeployed` = sum of active position sizes (SUBMITTED + FILLED)
- If `totalDeployed + newPositionSize > $250K` → skip trade, log "allocation cap"
- Configurable via `maxTotalAllocation` in Settings

## Daily Re-hydration

Every day after market close (4:15 PM ET), the scheduler automatically:
1. Syncs all IB positions (fills, closes, P&L)
2. Recalculates global + per-category performance stats
3. Saves portfolio snapshot for trend tracking
4. Runs AI trade analysis on any unreviewed completed trades
5. Updates portfolio value in config

---

## Layer 1: Dynamic Position Sizing

Instead of fixed dollar amounts, size positions based on conviction and risk.

**Long-term holds (Suggested Finds):**
- Base allocation = `portfolioValue * baseAllocationPct%` (default 2% = $20K on $1M)
- Multiplied by conviction: 10 = 1.5x, 9 = 1.25x, 8 = 1.0x, 7 = 0.75x
- Capped at `maxPositionPct%` of portfolio (default 5% = $50K)

**Scanner trades with stop loss:**
- Risk-based: `qty = (portfolio * riskPerTradePct%) / |entry - stop|`
- Example: 1% risk on $1M = $10K risk budget. If entry=$100, stop=$95, qty = $10K / $5 = 2000 shares
- Capped at `maxPositionPct%`

**Fallback:** If dynamic sizing disabled, uses flat `positionSize` as before.

---

## Layer 2: Automated Dip Buying

For long-term positions that drop, automatically average down in tiers.

| Tier | Dip from Avg Cost | Add-on Size (% of original qty) |
|------|-------------------|---------------------------------|
| 1    | -5%               | 50%                             |
| 2    | -10%              | 75%                             |
| 3    | -15%              | 100%                            |

Guards:
- Total position must stay under `maxPositionPct%` of portfolio
- Cooldown: no repeat dip-buy for same ticker within 24h
- Only LONG_TERM positions qualify
- Must be during market hours + IB connected

---

## Layer 3: Automated Profit Taking

For long-term positions that rally, trim in tiers to lock in gains.

| Tier | Gain from Avg Cost | Trim Size (% of position) |
|------|--------------------|---------------------------|
| 1    | +25%               | 20%                       |
| 2    | +50%               | 25%                       |
| 3    | +75%               | 25%                       |

Guards:
- Remaining position after trim >= `minHoldPct%` of original (default 30%)
- No repeated trim at the same tier for the same ticker
- Only LONG_TERM positions qualify

---

## Layer 4: Risk Management Overlays

### 4a. Market Regime Awareness

Fetches VIX level and SPY trend from the auto-trader service. Applies a multiplier
to all position sizes:

- VIX > 30 (panic): 0.5x multiplier, pause new long-term buys
- VIX 25-30 (fear): 0.6x multiplier
- VIX 15-25 (normal): 1.0x multiplier
- VIX < 15 (complacent): 1.1x multiplier (slight boost)
- SPY below 20-day SMA: additional 0.8x reduction

Config: `marketRegimeEnabled` (default: true)

### 4b. Sector Concentration Limits

Prevent over-allocation to a single sector.

- Each stock is tagged with its GICS sector (from Finnhub company profile)
- If a new trade would push sector exposure above `maxSectorPct%` (default 30%),
  the trade is skipped or size is reduced to fit
- Sectors cached for 24h per ticker

Config: `maxSectorPct` (default: 30)

### 4c. Earnings Calendar Blackout

Don't enter new positions within X days of earnings.

- Before placing any trade, check Finnhub `/calendar/earnings` for the ticker
- If earnings within `earningsBlackoutDays` (default 3), skip the trade
- Cached per ticker per day

Config: `earningsAvoidEnabled` (default: true), `earningsBlackoutDays` (default: 3)

### 4d. Win-Rate Adaptive Sizing (Half-Kelly)

Use actual trade history to adapt position sizing over time.

- Kelly fraction: `f = (winRate * avgWin - (1 - winRate) * avgLoss) / avgWin`
- Apply Half-Kelly (f / 2) as a multiplier on base position size
- Clamp between 0.25x and 2.0x for safety
- Minimum 10 completed trades required to activate

Config: `kellyAdaptiveEnabled` (default: false — activate after building track record)

---

## Configuration

All thresholds are stored in `auto_trader_config` (Supabase) and editable from the
Settings tab in the Paper Trading page. Defaults are designed for a $1M moderate-risk
paper account.

| Parameter               | Default | Description                           |
|------------------------|---------|---------------------------------------|
| max_total_allocation   | 250000  | Hard cap on total deployed capital    |
| use_dynamic_sizing     | true    | Enable conviction-weighted sizing     |
| portfolio_value        | 1000000 | Auto-updated from IB portfolio sum    |
| base_allocation_pct    | 2.0     | Base % per long-term position         |
| max_position_pct       | 5.0     | Max single-position % of portfolio    |
| risk_per_trade_pct     | 1.0     | Max risk % per scanner trade          |
| dip_buy_enabled        | true    | Enable automated dip buying           |
| dip_buy_tiers          | 3       | Number of dip-buy tiers               |
| dip_buy_cooldown_hours | 24      | Hours between dip buys for same stock |
| profit_take_enabled    | true    | Enable automated profit taking        |
| min_hold_pct           | 30      | Never sell below this % of original   |
| market_regime_enabled  | true    | Adjust sizing for VIX/SPY conditions  |
| max_sector_pct         | 30      | Max portfolio % in one sector         |
| earnings_avoid_enabled | true    | Skip trades near earnings             |
| earnings_blackout_days | 3       | Days before earnings to blackout      |
| kelly_adaptive_enabled | false   | Use Half-Kelly from trade history     |

---

## Data Flow

```
useAutoTradeScheduler (every 30min during market hours)
  │
  ├─ loadAutoTraderConfig() from Supabase
  ├─ syncPositions(accountId)
  ├─ Save portfolio snapshot
  │
  ├─ Update portfolioValue from IB positions
  ├─ getMarketRegime() → VIX/SPY → regimeMultiplier
  │
  ├─ checkDipBuyOpportunities(config, positions, regime)
  ├─ checkProfitTakeOpportunities(config, positions)
  │
  ├─ fetchTradeIdeas() → scanner results
  │   └─ For each idea:
  │       ├─ checkEarningsBlackout(ticker) → skip if near earnings
  │       ├─ checkSectorExposure(ticker) → skip if sector over limit
  │       ├─ calculatePositionSize(config, idea, regime, kelly)
  │       └─ processTradeIdea() → place bracket order
  │
  └─ processSuggestedFinds() → for each stock:
      ├─ checkEarningsBlackout(ticker)
      ├─ checkSectorExposure(ticker)
      ├─ calculatePositionSize(config, stock, regime, kelly)
      └─ place market buy
```

---

## Implementation Files

- `supabase/migrations/20260214000007_smart_sizing_config.sql` — DB migration
- `app/src/lib/autoTrader.ts` — Core logic (sizing, dip buy, profit take, regime, Kelly)
- `app/src/lib/paperTradesApi.ts` — Type updates (source: 'dip_buy' | 'profit_take')
- `app/src/hooks/useAutoTradeScheduler.ts` — Wire new checks into schedule loop
- `app/src/components/PaperTrading.tsx` — Settings UI sections
