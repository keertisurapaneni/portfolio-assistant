# Options Wheel Engine

**Last updated:** 2026-04-22  
**Status:** Live — paper trading mode (IB paper account DUP876374)  
**Auto-trade:** Configurable via `auto_trader_config.options_auto_trade_enabled`

---

## Overview

The Options Wheel Engine sells cash-secured puts on quality stocks from a curated watchlist. When a put expires worthless, the premium is kept as income. If assigned, shares are acquired at the net cost (strike − premium) and covered calls are sold to generate further income. The cycle repeats.

**Target return:** 70–80% annualized  
**Validation gate:** Paper trade until system beats 60% annualized for 2 consecutive months → enable live IB execution

---

## Architecture

```
Scheduler (every 15 min, market hours)
  └─ runOptionsScan()          options-scanner.ts   — morning entry scan
  └─ runOptionsManageCycle()   options-manager.ts   — every 30 min, position management
  └─ runDipWatcher()           dip-watcher.ts       — every 5 min, dip entry detection

Frontend
  └─ /options (OptionsWheelPage) — visible to all users (no login required)
       └─ OptionsTab.tsx       — Open / History / Watchlist / Log tabs
```

> **Note:** The "Today" (opportunities) tab was removed — open positions and watchlist with live prices are the primary daily views.

**Data stores:**
- `options_watchlist` — approved tickers with min_price and notes (leverage factor)
- `options_scan_results` — daily scan output with skip reasons
- `paper_trades` — positions (mode: OPTIONS_PUT / OPTIONS_CALL)
- `options_iv_history` — IV rank computation (52-week high/low per ticker)
- `auto_trade_events` — activity log (shown in Log tab)

---

## Scanner Entry Checks

Runs sequentially for each watchlist ticker. First failing check skips the ticker.

| # | Check | Rule | Skip Reason |
|---|-------|------|-------------|
| 0 | Time gate | Must be past 10:00 AM ET (first 30 min excluded) | `too_early_opening_30min` |
| 1 | Bear market gate | SPY above SMA200 = bull; below = bear mode with stricter params | logged only |
| 1.5 | Duplicate ticker | No open put already exists on this ticker | `duplicate_open_position` |
| 2 | Position limit | Max 5 concurrent puts (3 when VIX > 25) | `max_positions` |
| 3 | Min price | Stock ≥ $20 (or watchlist override) | `price_too_low_X` |
| 3.2 | Dip detection + Bollinger Bands | Fetches 30-day candles (zero extra API calls). ≥5% drop = dip entry bonus. Computes SMA20 ± 2σ → BB lower/upper bands + `bb_signal` (`at_lower` / `near_lower`). Stored in `options_scan_results`. | informational |
| 3.5 | Stock trend | Must be above 50-day SMA; not down >20% in 3 months | `below_sma50:X` / `down_Xpct_3m` |
| 3.6 | Beta filter | Skip if beta > 1.5 (leveraged ETFs exempt — they have dedicated gates) | `high_beta:X.XX` |
| 4 | Earnings blackout | No earnings within 7 days | `earnings_in_Xd` |
| 4.5 | News sentiment | No red-flag headlines; Finnhub score ≥ -0.3 | `news_red_flag:X` / `negative_sentiment:X` |
| 4.6 | Sector concentration | Max 2 open positions per sector | `sector_limit:X` |
| 4.7 | Bear mode sector | In bear market: only Consumer Staples, Utilities, Health Care, Financials | `bear_mode_non_defensive:X` |
| 5 | RSI | RSI < 38 and rising = high conviction bonus (soft signal, not a hard block) | informational only |
| 6 | Options chain | Fetch via IB Gateway; Black-Scholes synthetic fallback if IB unavailable | `no_options_chain` |
| 6a | SMA20 strike floor | Put strike must be ≤ 20-day SMA (Bollinger Band middle). Dip entries exempt. | `strike_above_sma20:X` |
| 6b | Prob profit floor | Strike OTM probability ≥ 75% | `low_prob_profit:XXpct` |
| 6.5 | Liquidity | Bid-ask spread < 30% of mid; bid > 0 | `wide_spread:XXpct` / `no_bid_no_market` |
| 7 | Premium yield | ≥ 1.5% monthly for regular stocks; ≥ 5% for leveraged ETFs; -0.5% grace for dip entries. Normalized by DTE: `(premium / strike) × (30 / dte)` | `low_premium_X.XXpct` |
| 8 | Capital sufficiency | Free capital ≥ strike × 100 (50% size in bear mode). Capital decremented per opportunity found during scan. | `insufficient_capital` |
| 9 | IV rank | IV rank ≥ 50 (≥ 25 for range-bound stocks). New tickers pass while history builds. | `iv_rank_low` (soft) |
| 9.5 | IV spike | No sudden >20pt IV jump in last 24h (= news event) | `iv_spike:+Xpts` |

### Delta Targets by Market Regime

| Condition | Delta Target | Probability OTM |
|-----------|-------------|-----------------|
| Bear mode (SPY < SMA200) | 0.15 | ~85% |
| Leveraged ETF (3× amplified vol) | 0.18 | ~82% |
| High conviction (RSI oversold) | 0.35 | ~65% |
| Normal | 0.30 | ~70% |

### Bollinger Band Timing Signal

Computed at check 3.2 from 20-day closes. Zero extra API calls — uses the same candle fetch as dip detection.

| `bb_signal` | Meaning | Impact |
|-------------|---------|--------|
| `at_lower` | Price ≤ BB lower band | Stock oversold, IV elevated, best premium entry. +1 contract bonus. |
| `near_lower` | Price ≤ BB lower × 1.05 | Near oversold — good entry but not maximum conviction. |
| `null` | Price in normal range | No BB timing bonus. |

Stored in `options_scan_results` as `bb_lower`, `bb_upper`, `bb_signal`.

### Contract Scaling (1–3 contracts)

Stacking order: base conviction → +1 dip entry → +1 BB lower band touch. Capped at 3.

| Condition | Contracts |
|-----------|-----------|
| Prob profit ≥ 80% AND IV rank ≥ 65 AND RSI oversold | 3 (base) |
| Prob profit ≥ 75% AND IV rank ≥ 55 | 2 (base) |
| All others | 1 (base) |
| + dip entry bonus | +1 |
| + BB `at_lower` signal | +1 |
| **Ceiling** | **3** |

---

## Position Manager

Runs every 30 minutes during market hours. Processes all FILLED / PARTIAL positions.

### Check Order (per position)

1. **Expired** (DTE ≤ 0) → close as `expired_worthless`, keep full premium  
2. **IB connectivity required** — skip remaining checks if IB disconnected  
3. **Stop-loss** — current premium > 3× collected (lost 2× premium) → hard close (`stop_loss`)  
4. **50% profit** — premium decayed to 50% of original → auto-close (`50pct_profit`)  
5. **Roll alert** — stock ≥ 5% below strike AND premium grown 1.5×+ AND DTE > 7 → fire warning event, human reviews chain and decides  
6. **21 DTE hard close** — close regardless of P&L; theta curve flattens, gamma risk rises. Profitable → `21dte_profit`; loss → `21dte_close`  
7. **Assignment detection** — stock < 98% of strike → warning event logged

### Live P&L Updates

Every cycle fetches current stock price from Finnhub and current option premium from IB chain, then updates `pnl` in `paper_trades`. The frontend reads this stored value.

---

## Dip Entry Watcher

Runs every 5 minutes, 10:00–15:55 ET.

- Fetches 20-day candles for each active watchlist ticker
- Flags tickers down ≥ 5% from 20-day high while still above SMA50 (uptrend intact)
- Logs informational event to `auto_trade_events` (visible in UI Log tab)
- Deduplicates: each ticker alerted at most once per calendar day

Dip entries receive: 0.5% yield grace, +1 contract bonus, SMA20 strike floor exemption.

---

## Leveraged ETF Handling

Watchlist notes encode leverage factor: `"3x|SOXL 3× Semi ETF"` → `leverageFactor = 3`

| Parameter | Regular Stock | Leveraged ETF |
|-----------|-------------|---------------|
| Delta target | 0.30 | 0.18 |
| Min monthly yield | 1.5% | 5.0% |
| Beta check | Enforced (max 1.5) | **Exempt** |
| SMA20 floor | Enforced | Enforced (unless dip) |

Current leveraged ETFs on watchlist: SOXL, TQQQ, NVDL, AAPU, TSLL

---

## Red Flag Keywords

**Hard blocks (one headline = skip):**  
`fraud`, `sec investigation`, `doj`, `chapter 11`, `chapter 7`, `going concern`, `delisting`, `fda rejection`, `restatement`, `accounting irregularit`, `whistleblower`, `ponzi`, `subpoena`

**Soft blocks (requires 2+ headlines):**  
`bankruptcy`, `class action`, `recall`, `ceo resign`, `cfo resign`

---

## Monthly Stats Calculation

- **Period:** calendar month (day 1 to today)
- **Premium collected:** sum of all closed trade P&L (wins + losses) — net result
- **Win rate:** closed trades with pnl > $1 / total closed trades with |pnl| > $1
- **Annualized return:** `(netPnl / totalCapitalDeployed) × (365 / daysElapsed) × 100`
- **Projected monthly income:** total premium locked in from all currently open puts — `sum(option_premium × option_contracts × 100)`. Shows the maximum income achievable if all open positions expire worthless.

---

## History Tab Close Reasons

| Badge | close_reason | Meaning |
|-------|-------------|---------|
| ✅ Expired | `expired_worthless` | Put expired, kept full premium |
| 💰 50% Close | `50pct_profit` | Auto-closed at 50% profit capture |
| ⏱️ 21 DTE Close | `21dte_profit` | Hard-closed at 21 DTE, profitable |
| ⚠️ 21 DTE Cut | `21dte_close` | Hard-closed at 21 DTE, at a loss |
| 🛑 Stopped | `stop_loss` | Premium exceeded 3× collected |
| 📌 Assigned | `assigned` | Put exercised, shares acquired |

---

## Watchlist

Managed via the Watchlist tab. Each card shows:
- Live market price + day change % (Finnhub real-time)
- Notes/description (auto-populated from Finnhub company profile on add)

Adding a ticker automatically fetches its description from Finnhub and inserts it into `options_watchlist.notes`. No manual note entry required.

Current watchlist includes: NVDA, AMD, PLTR, GOOGL, MSFT, AAPL, META, CRM, SNOW, NOW, CRDO, AVGO, ALAB, APP, SOXL, TQQQ, NVDL, TSLL + others.

---

## Key Files

| File | Purpose |
|------|---------|
| `auto-trader/src/lib/options-scanner.ts` | Entry scan, all checks, BB computation, trade ticket generation |
| `auto-trader/src/lib/options-manager.ts` | Position management, close/alert logic, monthly stats |
| `auto-trader/src/lib/options-chain.ts` | IB chain fetch + Black-Scholes synthetic fallback |
| `auto-trader/src/lib/dip-watcher.ts` | Dip entry detection, runs every 5 min |
| `auto-trader/src/scheduler.ts` | Cron schedule wiring |
| `app/src/components/PaperTrading/tabs/OptionsTab.tsx` | UI — Open / History / Watchlist / Log |
| `app/src/lib/optionsApi.ts` | Frontend Supabase queries, live price fetch, projected income |
| `supabase/migrations/20260422000003_options_scan_bb_signal.sql` | Adds `bb_lower`, `bb_upper`, `bb_signal` columns to `options_scan_results` |

---

## Go-Live Gate

Paper trading until **2 consecutive months** of annualized return > 60% (the "husband benchmark").  
Enable live trading: set `options_auto_trade_enabled = true` in `auto_trader_config` table.  
IB paper account: `DUP876374` → switch to live account credentials when ready.
