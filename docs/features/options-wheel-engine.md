# Options Wheel Engine

**Last updated:** 2026-04-24  
**Status:** Live — paper trading mode (IB paper account DUP876374)  
**Auto-trade:** ENABLED — `auto_trader_config.options_auto_trade_enabled = true`  
**Real orders:** Placed via IB Gateway (paper account); falls back to paper-only if IB offline

---

## Overview

The Options Wheel Engine sells cash-secured puts on quality stocks from a curated watchlist. When a put expires worthless, the premium is kept as income. If assigned, shares are acquired at the net cost (strike − premium) and covered calls are sold to generate further income. The cycle repeats.

**Target return:** 70–80% annualized  
**Validation gate:** Paper trade until system beats 60% annualized for 2 consecutive months → enable live IB execution

---

## Architecture

```
Scheduler (every 15 min, market hours)
  └─ runOptionsScan()          options-scanner.ts   — full-day entry scan (10 AM–3:30 PM)
  └─ runOptionsManageCycle()   options-manager.ts   — every 15 min, position management
  └─ runDipWatcher()           dip-watcher.ts       — every 5 min, dip entry detection

Frontend
  └─ /options (OptionsWheelPage) — visible to all users (no login required)
       └─ OptionsTab.tsx       — Open / History / Watchlist / Log tabs
```

**Data stores:**
- `options_watchlist` — approved tickers with tier, sector, min_price and notes (leverage factor)
- `options_scan_results` — daily scan output with skip reasons
- `paper_trades` — positions (mode: OPTIONS_PUT / OPTIONS_CALL); includes `roll_count`, `rolled_from_id`
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
| 2 | Position limit | Max 12 concurrent puts (6 when VIX ≥ 25) | `max_positions` |
| 3 | Min price | Stock ≥ $20 (or watchlist override) | `price_too_low_X` |
| 3.2 | Dip detection + Bollinger Bands | Fetches 30-day candles. ≥5% drop = dip entry bonus. SMA20 ± 2σ → BB lower/upper + `bb_signal`. | informational |
| 3.5 | Stock trend | Must be above 50-day SMA; not down >20% in 3 months | `below_sma50:X` / `down_Xpct_3m` |
| 3.6 | Beta filter | Skip if beta > 1.5 (leveraged ETFs exempt) | `high_beta:X.XX` |
| 4 | Earnings blackout | No earnings within 7 days | `earnings_in_Xd` |
| 4.5 | News sentiment | No red-flag headlines; Finnhub score ≥ -0.3 | `news_red_flag:X` |
| 4.6 | Sector concentration | Max 2 open positions per sector | `sector_limit:X` |
| 4.7 | Bear mode sector | In bear market: only Consumer Staples, Utilities, Health Care, Financials | `bear_mode_non_defensive:X` |
| 5 | RSI | RSI < 38 and rising = high conviction bonus (soft signal, not a hard block) | informational only |
| 6 | Options chain | Fetch via IB Gateway; Black-Scholes synthetic fallback if IB unavailable | `no_options_chain` |
| 6a | SMA20 strike floor | Put strike must be ≤ 20-day SMA. Dip entries exempt. | `strike_above_sma20:X` |
| 6b | Prob profit floor | Strike OTM probability ≥ tier minimum (70–75%) | `low_prob_profit:XXpct` |
| 6.5 | Liquidity | Bid-ask spread < 30% of mid; bid > 0 | `wide_spread:XXpct` |
| 7 | Premium yield | ≥ 1.5%/month regular; ≥ 5% leveraged ETFs; −0.5% grace for dip entries | `low_premium_X.XXpct` |
| 8 | Capital sufficiency | Free capital ≥ strike × 100 (50% size in bear mode) | `insufficient_capital` |
| 9 | IV rank | IV rank ≥ 50 (≥ 25 range-bound). New tickers pass while history builds. | `iv_rank_low` (soft) |
| 9.5 | IV spike | No sudden >20pt IV jump in last 24h | `iv_spike:+Xpts` |

---

### VIX-Tiered Delta Targets

Delta determines how far OTM the put strike is. Now driven by three factors: VIX level, 200-day SMA proximity, and market regime. Highest-specificity rule wins.

| Condition | STABLE Tier | GROWTH Tier | HIGH VOL Tier | Rationale |
|-----------|-------------|-------------|---------------|-----------|
| VIX > 30 **AND** stock within 5% of its 200 DMA | **0.35** | **0.35** | **0.20** | Max aggression: high IV = inflated premiums; 200 DMA = institutional support. We *want* assignment at these levels. |
| VIX 25–30 **OR** bear mode (SPY < SMA200) | **0.20** | **0.15** | **0.15** | Elevated risk: more OTM cushion, conservative capital deployment. |
| Normal market (VIX < 25, SPY above SMA200) | 0.25 (tier default) | 0.30 (auto-tuned) | 0.20 (tier default) | Standard regime: use tier defaults. |
| Leveraged ETF (any regime) | — | — | **0.18** | Extra cushion for amplified volatility. |
| RSI oversold + high conviction (any regime) | 0.35 | 0.35 | 0.20 | Confirmed oversold = strong entry signal. |

**Per-stock 200 SMA fetch:** The scanner fetches 220 days of daily candles for each stock to compute its own 200-day SMA. "Near 200 DMA" = stock price ≤ SMA200 × 1.05 (within 5%).

Each scan logs: `vixTier` (SPIKE/ELEVATED/NORMAL), `sma200Proximity` (price vs SMA), `deltaLogic` (which tier rule applied).

---

### Bollinger Band Timing Signal

| `bb_signal` | Meaning | Impact |
|-------------|---------|--------|
| `at_lower` | Price ≤ BB lower band | Oversold, IV elevated, best entry. +1 contract bonus. |
| `near_lower` | Price ≤ BB lower × 1.05 | Near oversold — good entry. |
| `null` | Price in normal range | No BB bonus. |

---

### Full-Day Scan Schedule

The scanner runs throughout the full trading session to catch opportunities at any time (not just the morning open).

| Session | Window | Cadence | Purpose |
|---------|--------|---------|---------|
| Morning | 10:00–11:30 AM ET | Every 15 min | Highest IV, earnings reactions, gap fills |
| Midday | 11:30 AM–2:00 PM ET | Every 30 min | News-driven drops, sector rotations, 200 DMA touches |
| Afternoon | 2:00–3:30 PM ET | Every 30 min | Late-session dislocations, pre-close IV elevation |

**Daily new-position cap:** Maximum `OPTIONS_MAX_NEW_PER_DAY = 3` new puts per calendar day. Counted from midnight ET across all scan windows. Prevents over-deploying capital on a single volatile day.

---

### Contract Scaling (1–3 contracts)

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

Runs every 15 minutes during market hours. Processes all FILLED / PARTIAL positions.

### Put Position Checks (in order)

1. **Expired** (DTE ≤ 0) → close as `expired_worthless`, keep full premium
2. **IB connectivity required** — skip remaining checks if IB disconnected
3. **Stop-loss** — current premium > 3× collected AND stock below strike → hard close (`stop_loss`)
4. **50% profit** — premium decayed to 50% of original → auto-close (`50pct_profit`)
5. **Early roll trigger** — stock ≥ 5% below strike AND premium 1.2–1.5× AND DTE > 14 → attempt `evaluateAndRollPut()` before loss worsens
6. **21 DTE smart roll-or-close** — at 21 DTE, attempt to roll down-and-out for credit; if roll not viable, hard-close (`21dte_profit` or `21dte_close`)
7. **Assignment detection** — stock < 98% of strike → warning event + covered call queued

**Rolling logic (`evaluateAndRollPut`):**
- Looks for same ticker put 4–6 weeks out, strike 5–10% lower
- Rolls only if net credit ≥ 0 (or small debit < $0.20/share)
- Increments `roll_count` on the new position; sets `rolled_from_id` to prior position id
- Falls through to hard-close if no viable roll found

### Covered Call Checks

When a put is assigned, a covered call is automatically queued with:
- **Delta target:** 0.20 (20-delta = ~80% OTM, leaves room for stock to recover)
- **DTE target:** 45 days (longer than old 30-day — more premium collected per cycle)
- **Strike floor 1:** At least 10% above current stock price
- **Strike floor 2 (cost basis guard):** Never below the put strike that caused assignment. Prevents selling calls at a price that guarantees a realized loss on the shares. If both floors overlap, we collect minimal premium but never lock in a loss.
- Logged with `inCostBasisProtectionMode` flag when the acquisition price floor is binding

**Covered call roll (Check C — `evaluateAndRollCall`):**
- Triggers when stock price ≥ 98% of call strike AND DTE > 5
- Attempts to roll up-and-out (higher strike, further expiry) for a net credit
- Mirrors put rolling logic — same credit/debit tolerance

---

## Dip Entry Watcher

Runs every 5 minutes, 10:00–15:55 ET.

- Fetches 20-day candles for each active watchlist ticker
- Flags tickers down ≥ 5% from 20-day high while still above SMA50 (uptrend intact)
- Logs informational event to `auto_trade_events`
- Deduplicates: each ticker alerted at most once per calendar day

Dip entries receive: 0.5% yield grace, +1 contract bonus, SMA20 strike floor exemption.

---

## Leveraged ETF Handling

| Parameter | Regular Stock | Leveraged ETF |
|-----------|-------------|---------------|
| Delta target | VIX-tiered (see above) | 0.18 (fixed) |
| Min monthly yield | 1.5% | 5.0% |
| Beta check | Enforced (max 1.5) | **Exempt** |
| SMA20 floor | Enforced | Enforced (unless dip) |

Current leveraged ETFs on watchlist: SOXL, TQQQ, NVDL, AAPU, TSLL

---

## Watchlist Tiers

| Tier | Beta Cap | Min IV Rank | Delta Target | Min Prob Profit | Max Contracts |
|------|---------|-------------|-------------|-----------------|---------------|
| STABLE (blue-chip) | 1.2× | 35 | 0.25 | 70% | 2 |
| GROWTH (quality tech) | 1.8× | 50 | 0.30 | 72% | 1 |
| HIGH VOL (momentum/leveraged) | 2.5× | 60 | 0.20 | 75% | 1 |

Watchlist now includes `sector` column for concentration tracking and UI filtering. 42 tickers across Healthcare, Financials, Consumer Staples, Technology, Utilities, and more.

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
- **Projected monthly income:** sum of all open put premiums × contracts × 100

---

## Monthly Loss Circuit-Breaker

If options P&L for the calendar month falls below **−5% of options budget** (−$25k on $500k), no new positions open until the next month. Existing positions continue to be managed normally.

---

## History Tab Close Reasons

| Badge | close_reason | Meaning |
|-------|-------------|---------|
| ✅ Expired | `expired_worthless` | Put expired, kept full premium |
| 💰 50% Close | `50pct_profit` | Auto-closed at 50% profit |
| ⏱️ 21 DTE Roll | `21dte_roll` | Rolled down-and-out at 21 DTE |
| ⏱️ 21 DTE Close | `21dte_profit` / `21dte_close` | Hard-closed at 21 DTE (roll not viable) |
| 🔄 Early Roll | `early_roll` | Proactive roll before loss worsened |
| 🛑 Stopped | `stop_loss` | Premium exceeded 3× collected |
| 📌 Assigned | `assigned` | Put exercised, shares acquired |

---

## Key Files

| File | Purpose |
|------|---------|
| `auto-trader/src/lib/options-scanner.ts` | Entry scan, VIX-tier delta, 200 DMA check, BB computation, trade ticket generation |
| `auto-trader/src/lib/options-manager.ts` | Position management, roll logic, CC params, cost-basis guard |
| `auto-trader/src/lib/options-chain.ts` | IB chain fetch + Black-Scholes synthetic fallback |
| `auto-trader/src/lib/dip-watcher.ts` | Dip entry detection, runs every 5 min |
| `auto-trader/src/scheduler.ts` | Cron schedule wiring, full-day scan windows, daily cap |
| `app/src/components/PaperTrading/tabs/OptionsTab.tsx` | UI — Open / History / Watchlist / Log; tier + sector filters |
| `app/src/lib/optionsApi.ts` | Frontend Supabase queries, live price fetch, projected income |
| `supabase/migrations/20260424000003_options_roll_tracking.sql` | Adds `roll_count`, `rolled_from_id` to `paper_trades` |
| `supabase/migrations/20260424000002_options_watchlist_sector_source.sql` | Adds `sector` column to `options_watchlist` |

---

## Go-Live Gate

Paper trading until **2 consecutive months** of annualized return > 60%.  
IB paper account: `DUP876374` → switch to live account credentials when ready.

---

## Phase 2 Roadmap

### Post-Earnings IV Crush Entries
High-conviction window 24–48h after earnings when direction is confirmed but IV still elevated 30–50%. The existing morning scan naturally passes the blackout check on day +1. Needs: `postEarningsMode` flag, lower IV floor (35 vs 50), +1 contract conviction bonus, earnings quality check (stock up ≥2%).

### Tuning Log UI
The auto-tune engine (Rules A–G) runs nightly and adjusts config silently. Build a read-only "Tuning History" tab showing last 7 runs from `strategy_tune_log`.

### Realized + Unrealized P&L Split
Add realized (locked-in) vs unrealized (mark-to-market) vs projected income as three separate lines in the stats header.
