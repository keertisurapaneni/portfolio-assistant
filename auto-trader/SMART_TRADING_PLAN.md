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

The scheduler runs **server-side** inside the auto-trader Node.js service (node-cron).
No browser tab needs to be open. The browser hook (`useAutoTradeScheduler`) detects the
server scheduler and defers to it; if the server isn't running, it falls back to
browser-side scheduling.

```
auto-trader service (node-cron: every 30min, 9:00-16:30 ET, weekdays)
  │
  ├─ loadConfig() from Supabase (direct DB query via service role key)
  ├─ preGenerateSuggestedFinds() → daily-suggestions edge function
  ├─ syncPositions() → IB positions + paper_trades updates
  ├─ savePortfolioSnapshot() → Supabase insert
  │
  ├─ Update portfolioValue from IB positions
  ├─ assessDrawdownMultiplier() → portfolio health check
  │
  ├─ checkDipBuyOpportunities() → IB positions + market orders
  ├─ checkProfitTakeOpportunities() → IB positions + market orders
  ├─ checkLossCutOpportunities() → IB positions + market orders
  │
  ├─ fetchTradeIdeas() → trade-scanner edge function
  │   └─ For each idea:
  │       ├─ fetchTradingSignal() → trading-signals edge function (full analysis)
  │       ├─ checkAllocationCap / checkSectorExposure / checkEarningsBlackout
  │       ├─ calculatePositionSize(config, idea, drawdownMultiplier)
  │       └─ placeBracketOrder() → IB Gateway
  │
  └─ runDailyRehydration() (after 4:15 PM ET)
      └─ syncPositions + recalculate performance
```

### Scheduler API (localhost:3001)

| Endpoint                    | Method | Description                   |
|-----------------------------|--------|-------------------------------|
| `/api/scheduler/status`     | GET    | Current state, last run, etc. |
| `/api/scheduler/run`        | POST   | Trigger a manual cycle        |
| `/api/scheduler/start`      | POST   | Start the cron scheduler      |
| `/api/scheduler/stop`       | POST   | Stop the cron scheduler       |

---

## Implementation Files

- `auto-trader/src/scheduler.ts` — Server-side scheduler (node-cron orchestration)
- `docs/INSTAGRAM-STRATEGY-ARCHITECTURE.md` — Instagram strategy ingestion, execution, and performance tracking
- `auto-trader/src/lib/supabase.ts` — Supabase client + DB helpers (config, trades, events)
- `auto-trader/src/routes/scheduler.ts` — REST API for scheduler status/control
- `app/src/lib/autoTrader.ts` — Core logic (sizing, dip buy, profit take, regime, Kelly)
- `app/src/hooks/useAutoTradeScheduler.ts` — Browser fallback (defers to server when active)
- `app/src/components/PaperTrading.tsx` — Settings UI + Smart Trading tab
- `supabase/migrations/20260214000007_smart_sizing_config.sql` — DB migration

---

## Always-On Trading

The auto-trader runs via macOS launchd (starts on user login) with IB Gateway + IBC.
As long as the laptop is on and IB Gateway is connected, trades happen automatically
with no browser needed.

### Future: Fully Always-On (No Laptop Required)

### Option 1: Cloud VPS with Docker (Recommended first step)

Move IB Gateway + IBC + auto-trader to a cloud VM (DigitalOcean, Hetzner, AWS).

- **LOE**: 2-3 days
- **Cost**: ~$5-10/mo
- **What changes**: Dockerize IB Gateway + IBC + auto-trader service, deploy via
  docker-compose, point Vercel app to the cloud VM's URL instead of localhost.
- **Trade-off**: IB Gateway still requires weekly 2FA re-auth via IB mobile app.
  IBC handles the restart automatically, but you'd confirm the login prompt ~once/week.

### Option 2: Switch to Alpaca (Fully serverless)

Replace IB with Alpaca's cloud-native REST API — no gateway or VM needed at all.

- **LOE**: 4-5 days
- **Cost**: Free (paper trading), $0 commissions on live
- **What changes**: Rewrite `ibClient.ts` for Alpaca API, potentially move auto-trader
  logic into Supabase Edge Functions or Vercel serverless functions. Eliminates the
  local service entirely.
- **Trade-off**: Leaves IB ecosystem; would need Alpaca account for live trading.
  Alpaca supports bracket orders, market/limit orders, and real-time streaming natively.

### Option 3: Dedicated home hardware (Cheapest)

Raspberry Pi 5 or mini PC running the current stack 24/7.

- **LOE**: 1 day
- **Cost**: $50-100 one-time
- **What changes**: Install Node.js, IB Gateway, IBC on the device, run existing scripts.
- **Trade-off**: Depends on home internet/power reliability. Still needs weekly IB 2FA.
