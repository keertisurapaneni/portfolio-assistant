# Options Wheel Strategy — How We Make Money with Options

**Prepared by:** Keerti  
**Last updated:** April 22, 2026  
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

**Step 3 — If we get the shares.** We immediately start collecting rent on those shares by selling a *covered call* — someone pays us to agree to sell our shares at a higher price. More cash collected.

**Step 4 — Repeat.** The cycle keeps going — Put → (hold or assign) → Covered Call → repeat. This is the "wheel."

---

## Why This Strategy Works

| Factor | What It Means |
|---|---|
| We only sell puts on quality stocks | NVDA, AAPL, MSFT, META — companies we'd be comfortable owning |
| We set the price conservatively | Our target strike is ~30% below the current price (30-delta), meaning the stock has to fall significantly before we're affected |
| We only sell when "rent" is high | We require IV Rank > 50, meaning the option premium is elevated — we're getting paid well for the risk |
| We exit at 50% profit | When we've captured half our potential gain, we close and redeploy. No need to hold until expiry. |
| We have automated stop-losses | If a trade goes 3× against us, the system closes automatically to protect capital |

---

## The Automation — What the System Does Daily

This is fully automated. There is no manual trading happening. The system runs 24/7 and makes decisions based on rules we set.

### Morning (10:00–11:30 AM ET) — The Scanner
The system scans our 20+ approved stocks and checks 14 conditions before opening any position:

1. Is the overall stock market healthy? (SPY above 200-day average)
2. Is there an earnings announcement coming up? (Skip if within 7 days — too risky)
3. Is the news for this stock clean? (No fraud, lawsuits, SEC investigations)
4. Is the option premium high enough to be worth our time? (≥1.5% monthly)
5. Is the stock in an uptrend? (Must be above its 50-day moving average)
6. Is the stock at or near a technical buying zone? (Bollinger Band lower band — oversold signal)
7. Is there enough capital to cover the trade? (Always cash-secured — no margin)
8. ...and 7 more checks.

If all checks pass → the system automatically opens a paper trade.

### Every 30 Minutes — The Manager
The system monitors all open positions and:
- Closes any position that has reached **50% profit** (locks in gains early)
- Alerts if a position needs attention (stock dropped near our strike price)
- Automatically queues a **covered call** if a stock gets assigned to us
- Hard-closes any position where losses exceed **3× the premium collected** (stop-loss protection)

### 1:30 PM ET — The Redeployment Scan *(new)*
If any positions closed at 50% profit this morning, the system runs a second scan to redeploy that freed-up capital the same day — so cash isn't sitting idle.

---

## Our Approved Stock List (Watchlist)

We only sell options on stocks we have researched and would genuinely be comfortable owning:

| Category | Stocks |
|---|---|
| Big Tech | NVDA, AMD, AAPL, MSFT, META, GOOGL |
| Software/Cloud | CRM, SNOW, NOW, PLTR |
| Semiconductors | CRDO, AVGO, ALAB |
| Consumer Tech | APP |
| Leveraged ETFs (higher yield, higher risk) | SOXL, TQQQ, NVDL, TSLL |

Leveraged ETFs are treated more conservatively — we require a 5% monthly premium (vs 1.5% for regular stocks) and use a smaller position delta (18 vs 30) because they are more volatile.

---

## Risk Management — How We Protect the $500k

We have multiple layers protecting the capital:

| Protection Layer | How It Works |
|---|---|
| **Cash-secured only** | Every put is fully backed by cash — if we had to buy 100 shares, we have the cash. No borrowed money, no margin. |
| **Sector concentration cap** | Maximum 2 open positions in any single industry. No over-concentration in tech. |
| **Bear market mode** | If the S&P 500 drops below its 200-day average, the system automatically switches to defensive mode: smaller positions, lower-risk sectors only (Consumer Staples, Utilities, Healthcare), shorter expiry dates. |
| **50% profit exit** | We don't wait for full expiry. Capturing 50% of the premium in half the time is a better risk/reward than holding for the last 50%. |
| **21-day hard close** | Regardless of profit/loss, positions are closed when 21 days remain. After that point, the math changes — risk goes up faster than reward. |
| **3× stop-loss** | If the option premium triples (we're down 2× what we collected), the position is closed immediately. |
| **Monthly loss circuit-breaker** | If total options losses in a calendar month exceed 5% of the $500k budget ($25,000), no new positions are opened until the following month. |
| **No earnings risk** | We never hold an options position through an earnings announcement — results are too unpredictable. |

---

## The Income Math

### Conservative scenario (75% win rate)

| Metric | Value |
|---|---|
| Capital deployed | $500,000 |
| Average position size | ~$42,000 (12 positions) |
| Average monthly premium per position | ~$420–840 (1–2% of position) |
| Typical cycle time | 12–15 days (close at 50% profit early) |
| Cycles per month per slot | ~2 (positions recycle) |
| Theoretical gross monthly | ~$10,000 |
| After losses (~25% of trades) | ~$6,500–7,000/month |
| **Realistic target** | **$5,000–6,000/month** |

### How the $5,000 target is met
- 12 open positions × $500 average premium collected = $6,000/month if all expire worthless
- With stop-losses and losses: ~$5,000 net realistic
- Capital redeployment (afternoon re-scan) pushes this closer to $6,000–7,000 when fully operational

---

## Current Status — Paper Trading Phase

We are currently in **paper trading mode** — all trades are simulated with real market prices but no real money at risk. This is intentional.

**Go-live criteria:** Two consecutive months of annualized return above 60%.

Once that's achieved, we'll switch to the live IB (Interactive Brokers) account with real capital.

| What | Status |
|---|---|
| Paper account | DUP876374 (Interactive Brokers simulated) |
| Live account | Ready, not yet active |
| Go-live gate | 2 months beating 60% annualized return |
| Current monitoring | Full dashboard at portfolio-assistant app |

---

## What We Monitor (Dashboard View)

The portfolio assistant app shows:

- **Income progress bar** — "$X collected this month / $5,000 target" with projected income if all open positions expire
- **Budget meter** — How much of the $500k is currently deployed vs available
- **Position health split** — "⚠️ Needs Attention" (near strike) vs "✅ Healthy" positions
- **Today's Activity** — Every options event (opened, closed at 50%, assigned, covered call placed) with timestamps
- **History tab** — All closed trades with reason codes (expired, 50% close, stop-loss, assigned)

---

## Summary — Why This is Conservative and Sustainable

This is **not** day trading. We are not trying to predict stock movements.

We are:
1. Choosing quality stocks we'd be comfortable owning long-term
2. Getting paid upfront to agree to buy them at a discount
3. Exiting early when we've made good profit
4. Letting automation enforce discipline (no emotional decisions)
5. Running with multiple hard safety limits that protect the $500k

The goal is **steady, boring income** — not home runs. $5,000/month from $500,000 is a 12% annualized return, which is achievable and sustainable through this strategy when run consistently.

---

*For questions about the system, the dashboard, or specific trades — reach out to Keerti.*
