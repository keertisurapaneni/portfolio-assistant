# Options Wheel Strategy — How We Make Money with Options

**Prepared by:** Keerti  
**Last updated:** April 23, 2026  
**Account:** Paper trading (simulated) — $1,000,000 portfolio  
**Options budget:** $500,000 allocated to this strategy  
**Monthly income target:** $5,000+

---

## The Big Picture in One Sentence

We run a repeating cycle where we collect rent on stocks we'd be happy to own — and if we ever have to buy them, we immediately start collecting rent on them again.

---

## The Options Wheel: A Simple Analogy

Think of it like being a landlord for stocks.

**Step 1 — Collect rent upfront.** We agree to buy a stock at a price lower than it is today, and someone pays us cash right now for making that promise. This is called *selling a put option*. We get the cash immediately, no matter what happens.

**Step 2 — Two outcomes:**
- **The stock stays above our agreed price** → Our promise expires, we keep all the cash, and we start the cycle again. This happens most of the time (~75–80% of trades).
- **The stock drops below our agreed price** → We buy the shares (called *assignment*). But because we already collected cash upfront, our real cost is lower than what we paid.

**Step 3 — If we get the shares.** We immediately start collecting rent on those shares by selling a *covered call* — someone pays us to agree to sell our shares at a higher price. More cash collected. The covered call is always set at least 10% above the current stock price, so the stock has room to recover.

**Step 4 — Repeat.** The cycle keeps going — Put → (hold or assign) → Covered Call → repeat. This is the "wheel."

---

## The Approved Stock List — Now Organized by Tier

We now categorize all approved stocks into three tiers, each with its own rules. This is the biggest upgrade to the strategy: **we no longer treat all stocks the same.**

### 🟢 STABLE Tier — Blue-chip / Dividend stocks
*Lower volatility, we're very comfortable owning these, sell even at moderate premium*

| Stocks | Why |
|--------|-----|
| JPM, KO, HD, COST, MA, V, UNH | Dividend leaders, liquid, steady |
| AAPL, GOOGL, MSFT, AMZN, ORCL | Mega-cap tech, very liquid chains |

**Rules for STABLE stocks:**
- Beta (volatility) cap: **1.2×** the market *(most forgiving)*
- Minimum IV rank: **35** *(we sell premium even at lower volatility — these names rarely spike)*
- Target strike: **25-delta** *(25% chance of assignment — further out for more cushion)*
- Minimum probability of profit: **70%** *(slightly relaxed — stable stocks move less)*
- Max contracts per trade: **2** *(we're comfortable with double exposure on quality names)*

---

### 🔵 GROWTH Tier — Quality large-cap tech
*Moderate volatility, strong fundamentals, standard rules*

| Stocks | Why |
|--------|-----|
| META, NVDA, AVGO, NOW, SNOW | Quality tech growth, high institutional ownership |
| PANW, DDOG, NFLX | Cloud/streaming leaders, liquid options |

**Rules for GROWTH stocks:**
- Beta cap: **1.8×** the market
- Minimum IV rank: **50** *(auto-adjusted by the system over time)*
- Target strike: **30-delta** *(standard rule — 30% chance of assignment)*
- Minimum probability of profit: **72%**
- Max contracts per trade: **1**

---

### 🟡 HIGH VOL Tier — High-beta / Momentum stocks
*More volatile, higher premiums, tighter rules to compensate*

| Stocks | Why |
|--------|-----|
| AMD, TSLA, PLTR, APP | High-beta tech/momentum |
| ALAB, CRDO, RDDT | Smaller/newer growth names |
| SOXL, TQQQ, NVDL, TSLL | Leveraged ETFs *(highest premium, highest risk)* |

**Rules for HIGH VOL stocks:**
- Beta cap: **2.5×** the market
- Minimum IV rank: **60** *(only sell when premium is genuinely elevated)*
- Target strike: **20-delta** *(further OTM — more cushion because these move fast)*
- Minimum probability of profit: **75%** *(strictest floor)*
- Max contracts per trade: **1** *(no doubling up on volatile names)*

---

## The Weekly Screener — How We Find New Stocks

Every Monday morning, the system automatically screens 100+ S&P 500 and Nasdaq 100 stocks to suggest new additions to our watchlist. It filters by:
- Market cap ≥ $5 billion (ensures liquid options chain)
- Price between $15 and $2,000
- Beta between 0.3 and 2.8
- Not already on our watchlist

The top 20 candidates appear in the app's Watchlist tab as "Weekly Suggestions." We can review each one, add it with a single click, or dismiss it. New tickers are auto-assigned to the right tier based on their beta.

---

## The Automation — What the System Does Daily

This is fully automated. There is no manual trading happening. The system runs 24/7 and makes decisions based on rules we set.

### Morning (10:00–11:30 AM ET) — The Scanner
The system scans all approved stocks and checks **14+ conditions** before opening any position:

1. Is the overall stock market healthy? (SPY above 200-day average)
2. Is the stock's beta within the tier's limit? (Different per tier — see above)
3. Is the stock near its 52-week high? *(Skip if within 5% — near all-time highs = thin safety margin)*
4. Is there an earnings announcement coming up? (Skip if within 7 days — too risky)
5. Is the news for this stock clean? (No fraud, lawsuits, SEC investigations)
6. Is the option premium high enough for this tier? (≥1.5% monthly for STABLE/GROWTH; ≥5% for leveraged ETFs)
7. Is the stock in an uptrend? (Must be above its 50-day moving average)
8. Is the stock at or near a technical buying zone? (Bollinger Band lower band)
9. Is the IV rank above the tier's floor? (Different minimum per tier)
10. Is there enough capital to cover the trade? (Always cash-secured — no margin)
11. Are we at the position limit? (Max 12 positions total; max 6 when market is stressed)
12. Do we already have a position in this stock? (No stacking)
13. Are we over-concentrated in one industry? (Max 2 positions per sector)
14. Is the bid-ask spread reasonable? (Must be < 30% of mid — ensures liquid options)

If all checks pass → the system automatically opens a paper trade.

### Every 30 Minutes — The Manager
The system monitors all open positions and:
- Closes any position that has reached **50% profit** (locks in gains early)
- Closes any position with **21 days left** (time decay math changes after this point)
- Alerts if a position needs attention (stock near our strike price)
- Hard-closes any position where losses exceed **3× the premium collected** *(AND the stock is actually below our strike — prevents false triggers from pure IV spikes)*
- Automatically queues a **covered call** if a stock gets assigned to us *(always 10%+ above current price)*
- Monitors covered calls and closes them at 50% profit, manages expiry, and rolls if needed

### 1:30 PM ET — The Afternoon Redeployment Scan
If any positions closed at 50% profit this morning, the system runs a second scan to redeploy freed capital the same day — so cash isn't sitting idle.

### Monday 10:30 AM ET — Weekly Screener
Screens 100+ stocks to surface new watchlist candidates (see above).

---

## When the Strategy Extends Time (High IV Rule)

When market fear is very high (IV Rank ≥ 70 for a stock), the system extends the option's time to expiry from the usual 30–45 days to **60 days**. This lets us collect roughly 1.8× the premium while only tying up 1.4× the capital — a better ratio. As fear subsides and the premium falls, we close at 50% profit as usual.

---

## The Roll Strategy — What Happens When a Stock Drops

If a stock drops below our strike price AND there is still 7+ days until expiry AND the premium has only grown to 1.2× what we collected (not yet a full stop-loss), the system flags the position for a **roll**:

- We close the current put (taking a small loss on premium)
- We re-open a new put at a lower strike price and further-out expiry
- This collects new premium that helps offset the loss and gives the stock time to recover

We do **not** roll if: the stock has truly broken down (would require assignment), or if losses have already hit the 3× stop-loss.

---

## Risk Management — How We Protect the $500k

We have multiple layers protecting the capital:

| Protection Layer | How It Works |
|---|---|
| **Cash-secured only** | Every put is fully backed by cash — if we had to buy 100 shares, we have the cash. No borrowed money, no margin. |
| **Per-tier rules** | Stricter rules for volatile stocks (HIGH VOL tier), more relaxed for blue-chips (STABLE tier). Not one-size-fits-all. |
| **Market discount gate** | We skip selling puts if a stock is within 5% of its 52-week high. Near all-time highs = little margin of safety. We wait for a pullback. |
| **Sector concentration cap** | Maximum 2 open positions in any single industry. No over-concentration in tech. |
| **Bear market mode** | If the S&P 500 drops below its 200-day average, the system automatically switches to defensive mode: smaller positions, lower-risk sectors only (Consumer Staples, Utilities, Healthcare), shorter expiry dates. |
| **50% profit exit** | We don't wait for full expiry. Capturing 50% of the premium in half the time is better risk/reward than holding for the last 50%. |
| **21-day hard close** | Positions are closed when 21 days remain. After that point, risk goes up faster than reward. |
| **Smart stop-loss** | If the option premium triples (3× what we collected) AND the stock is actually below our strike price — the position is closed immediately. The stock must be genuinely moving against us, not just an IV spike. |
| **10% covered call floor** | When we're assigned shares, we sell a covered call at least 10% above the current price — giving the stock room to recover before we'd have to sell it. |
| **Monthly loss circuit-breaker** | If total options losses in a calendar month exceed 5% of the $500k ($25,000), no new positions open until the following month. |
| **No earnings risk** | We never hold an options position through an earnings announcement — results are too unpredictable. |
| **Auto-tuner conservatism** | The system auto-adjusts parameters based on performance, but has hard caps: max 3 contracts per trade, delta never goes above 0.30, IV floor never drops below 50. It can tighten rules easily but loosens them only after 20+ trades of sustained success. |

---

## What "Honest P&L" Means in the Dashboard

The dashboard shows three income numbers for complete transparency:

| Line | What It Means |
|---|---|
| ✅ **Realized (closed)** | Premium from positions already closed with profit. This is real, locked-in income. |
| **Mark-to-market** | For open positions, whether they're currently worth more or less than when we sold them. Negative = the option is now more expensive (bad scenario). Positive = premium is decaying (good). |
| 💰 **Cash collected (open, unearned)** | Cash already received from open positions that hasn't been "earned" yet. If the position closes profitably, this becomes Realized income. If it hits a stop-loss, part of it is lost. |

The dashboard also shows a **Crash Scenario card** estimating estimated losses if the market drops 30% or 50% — so we always have visibility into our worst-case exposure.

---

## The Income Math

### Current watchlist capacity
| Tier | Stocks | Avg Premium/Month | Contracts |
|------|--------|-------------------|-----------|
| STABLE (12 stocks) | JPM, HD, AAPL, GOOGL, MSFT, COST, etc. | $200–400/contract | Up to 2 |
| GROWTH (8 stocks) | META, NVDA, AVGO, PANW, NFLX, etc. | $300–600/contract | 1 |
| HIGH VOL (10 stocks) | AMD, TSLA, PLTR, RDDT, SOXL, etc. | $400–800/contract | 1 |

### Path to $5,000/month
| Phase | Positions Open | Estimated Monthly Income |
|-------|---------------|--------------------------|
| Now (April) | 2–3 | $500–$800 |
| May | 5–8 | $1,500–$2,500 |
| June+ (fully ramped) | 12–18 | $3,500–$6,000 |

**Why the ramp-up?** The scanner only opens positions when all 14+ conditions align. In low-IV markets (like the current April rally), many stocks don't have enough premium to pass the checks. As the market normalizes, more opportunities open up and capital recycles faster. Patience here is a feature, not a bug — forcing trades in bad conditions would be worse.

---

## Current Status — Paper Trading Phase

We are currently in **paper trading mode** — all trades are simulated with real market prices but no real money at risk. This is intentional.

**Go-live criteria:** Two consecutive months of annualized return above 60%.

Once achieved, we'll switch to the live IB (Interactive Brokers) account with real capital.

| What | Status |
|---|---|
| Paper account | DUP876374 (Interactive Brokers simulated) |
| Live account | Ready, not yet active |
| Go-live gate | 2 months beating 60% annualized return |
| Current monitoring | Full dashboard at portfolio-assistant app |

---

## What We Monitor (Dashboard View)

The portfolio assistant app shows:

- **Income progress bar** — "Realized: $X | Mark-to-market: ±$Y | Cash at risk: $Z" vs $5,000 target
- **Crash scenario card** — estimated loss at -30% and -50% market drop across all open puts
- **Budget meter** — how much of the $500k is currently deployed vs available
- **Position health** — "⚠️ Needs Attention" (near strike or roll needed) vs "✅ Healthy"
- **Watchlist tab** — all approved stocks with tier badge, live price, and weekly suggestions
- **Today's Activity** — every options event (opened, closed at 50%, assigned, covered call placed)
- **History tab** — all closed trades with plain-English explanation of why each was closed

---

## Summary — Why This is Conservative and Sustainable

This is **not** day trading. We are not trying to predict stock movements.

We are:
1. Choosing quality stocks in three tiers based on their volatility profile
2. Applying stricter rules to riskier stocks, relaxed rules to stable blue-chips
3. Getting paid upfront to agree to buy stocks we like at a discount
4. Exiting early when we've made good profit (50% capture rule)
5. Letting automation enforce discipline — no emotional decisions
6. Waiting for the right conditions; sitting on cash is better than forcing bad trades
7. Running with multiple hard safety limits that protect the $500k

The goal is **steady, boring income** — not home runs. $5,000/month from $500,000 is a 12% annualized return, which is achievable and sustainable through this strategy when run consistently.

---

*For questions about the system, the dashboard, or specific trades — reach out to Keerti.*
