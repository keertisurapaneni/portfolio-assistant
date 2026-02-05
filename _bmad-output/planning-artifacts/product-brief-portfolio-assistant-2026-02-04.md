---
stepsCompleted: [1, 2, 3, 4, 5]
inputDocuments:
  - planning-artifacts/brainstorm/problem_frame.md
date: 2026-02-04
author: keerti
project_name: portfolio-assistant
---

# Product Brief: Portfolio Assistant

## Executive Summary

**Portfolio Assistant** is a personal investing decision-support tool for a small group of active retail investors (up to 10 users). It exists to solve one core problem: the gap between _having information_ and _acting on it with confidence_.

Unlike generic screeners that optimize for metrics, this tool optimizes for how we actually make decisions — forcing us to externalize our reasoning, tracking outcomes against expectations, and surfacing thesis drift before price makes it obvious.

The goal is not more data. The goal is **earlier, more confident action**.

---

## Core Vision

### Problem Statement

Active retail investors spend hours researching stocks across scattered tools — screeners, news sites, earnings reports, spreadsheets — yet still miss opportunities, hold losers too long, and forget why they bought something in the first place.

The deeper problem isn't information scarcity. It's **thesis amnesia** and **action paralysis**:

- Original reasoning lives only in our heads
- Outcomes never get compared to expectations
- Signals accumulate without translating into conviction changes
- Selling happens late — after price forces the realization, not before

### Problem Impact

Without a system to counter these patterns, we:

- Hold positions past their thesis expiration because "nothing dramatically bad happened"
- Miss gradual thesis erosion until it becomes obvious underperformance
- Overweight narrative and early excitement when buying
- Underweight slow, boring execution that compounds quietly
- Delay exits on gradual breakdown vs. clean breaks

The cost isn't just financial. It's the cognitive load of knowing you _should_ be tracking this but aren't — and the regret when price finally confirms what you could have seen earlier.

### Why Existing Solutions Fall Short

| Solution                                           | Gap                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Screeners** (Finviz, Stock Rover)                | Optimize for metrics, not decisions. No thesis tracking, no outcome comparison. |
| **Portfolio trackers** (Sharesight, Yahoo Finance) | Track holdings and returns, not reasoning. No conviction signals.               |
| **Note-taking** (Notion, spreadsheets)             | Manual, disconnected from market data. Requires discipline we don't have.       |
| **News aggregators**                               | Surface information without mapping to holdings or suggesting action.           |

None of these close the loop between _why I bought_, _what's happened since_, and _should my conviction change_.

### Proposed Solution

A unified decision-support system with four core capabilities:

1. **Discovery** — Surface high-conviction opportunities (Quiet Compounders, Gold Mine candidates) we'd miss with passive scanning
2. **Conviction Score** — Weighted signal (valuation, quality, momentum, thesis strength) that translates to Buy/Hold/Sell guidance
3. **Outcome Tracker** — Externalize the thesis at purchase, track earnings and events against expectations, flag thesis drift
4. **Action Insights** — Parse news and earnings, map to holdings, suggest "review needed" or "no action"

### Key Differentiators

1. **Built for bias mitigation** — Explicitly designed to counter our known weaknesses: narrative overweighting, boring-stock underweighting, and gradual-erosion exit delays
2. **Thesis-first architecture** — The thesis isn't metadata; it's the organizing principle. Everything tracks back to "is my original reasoning still valid?"
3. **10-user constraint as feature** — No need to generalize. Every decision optimizes for exactly how we invest.
4. **Conviction over information** — The goal isn't more data; it's translating data into confident action earlier

---

## Target Users

### Primary Users

**User Profile: The Active Retail Investor (up to 10 users)**

A small, closed group of investors who share a common need but differ in style:

| User Type                                | Count   | Engagement Level                    |
| ---------------------------------------- | ------- | ----------------------------------- |
| **Power Users** (Keerti, Husband)        | 2       | Daily/Regular — most engaged        |
| **Regular Users** (close friends/family) | Up to 8 | Weekly to monthly — independent use |

**Shared Characteristics:**

- Intermediate investing skill (not beginners, not pros)
- Time-constrained (can't dedicate hours daily to research)
- Long-term oriented (not day trading)
- Self-directed (no advisor, make own decisions)

**Key Differences:**

- Different risk tolerances and portfolio sizes
- Different investing styles (growth vs. value vs. dividend vs. blend)
- Different check-in frequencies
- Some shared stock interests, but mostly independent portfolios

### User Interaction Model

**Each user independently:**

- Inputs their own list of tickers (holdings + watchlist)
- Sees conviction scores and signals for their stocks
- Maintains their own thesis notes (if they choose)
- Receives alerts relevant to their holdings

**No shared features in MVP:**

- No shared watchlists or collaborative features
- No "what is everyone else holding" views
- No social/discussion features

This keeps the system simple: **your tickers → your insights**.

### User Journey

**Onboarding (< 2 minutes):**

1. User imports portfolio via CSV/Excel OR enters tickers manually
2. System auto-detects columns (ticker, shares, avg cost) from import
3. System pulls data and generates initial conviction scores
4. User sees dashboard of their holdings with scores and position weights

**Core Loop (Weekly):**

1. Open dashboard → see any conviction changes or alerts
2. Click into a stock → see why score changed (earnings, news, price movement)
3. Optionally: add/update thesis notes
4. Decide: hold, add, trim, or sell

**"Aha" Moment:**

- Seeing a conviction score drop on a stock they were complacent about
- Discovering a quiet compounder through Discovery mode
- Getting an earnings alert that prompts action before price moves

---

## Build Constraint

> **This is a personal project intended to be built in 10-15 hours total using AI-assisted development.**
>
> All scope and architecture decisions must optimize for:
>
> 1. **Speed** — What can be built fastest with AI assistance?
> 2. **Clarity** — What's simplest to understand and maintain?
> 3. **Usefulness** — What delivers value on day 1?
> 4. **Polish** — UI should be clean, modern, and pleasant to use daily
>
> **Where to invest time:**
>
> - Clean, intuitive UI (modern component libraries — Tailwind, shadcn/ui, etc.)
> - Core workflows that feel good to use
> - Clear data visualization for conviction scores
>
> **Where to cut corners:**
>
> - Scalability beyond 10 users
> - Auth complexity (simple login is fine)
> - Edge case handling (handle the 80% case well)
> - Mobile optimization (desktop-first is fine)
> - Feature completeness (MVP features only)

---

## Success Metrics

### How We'll Know It's Working

This is a personal tool, not a business. Success is measured by **feel and outcomes**, not dashboards.

**The Real Test:**

> "Over time, did using this tool help us make better investing decisions?"
>
> Observable in: Portfolio performance, fewer regretted holds, more confident action.

### Usage Success (Behavioral)

| Signal                           | What It Means                             |
| -------------------------------- | ----------------------------------------- |
| **Opening it daily**             | It's useful enough to check regularly     |
| **Acting on alerts**             | The signals are actionable, not noise     |
| **Using thesis tracking**        | Externalizing reasoning is becoming habit |
| **Finding stocks via Discovery** | Surfacing opportunities we'd have missed  |

If we stop using it after a month, it failed. If it becomes part of the routine, it succeeded.

### Outcome Success (Observable in Portfolio)

These aren't tracked in the tool — they're observed in real life:

| Outcome                            | Evidence                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------- |
| **Earlier exits on broken thesis** | "I sold X before it dropped further because the tool flagged thesis drift" |
| **Higher-conviction holds**        | "I held Y through volatility because conviction score stayed strong"       |
| **Better discoveries**             | "I found Z through Discovery mode and it worked out"                       |
| **Reduced regret**                 | Fewer "I knew I should have sold that" moments                             |

### What We're NOT Tracking

- No analytics dashboards
- No usage metrics or engagement tracking
- No A/B testing or conversion funnels
- No formal ROI calculation

**The portfolio is the scoreboard.** Husband will see it there.

### Month 1 Success Criteria

After 30 days, the tool is working if:

1. We're still opening it regularly (didn't abandon it)
2. At least one decision was influenced by a conviction score or alert
3. It feels like less cognitive load, not more

---

## MVP Scope

### Core Features (Must Ship)

**1. Conviction Score Dashboard**
The heart of the product. Shows all your stocks with a clear conviction posture.

| Element               | Description                                               |
| --------------------- | --------------------------------------------------------- |
| **Stock list**        | User's tickers with current conviction score              |
| **Posture**           | Buy / Hold / Sell with confidence level (High/Medium/Low) |
| **Rationale**         | 2-3 bullet explanation tied to inputs                     |
| **Recent validation** | Last earnings outcome summary                             |
| **Score trend**       | How conviction has changed over time                      |
| **Last updated**      | When data was refreshed                                   |

**Posture Examples:**

| Display              | Meaning                                           |
| -------------------- | ------------------------------------------------- |
| 🟢 **Buy** (High)    | Strong signal, data aligns, thesis intact         |
| 🟢 **Buy** (Low)     | Numbers lean buy, but uncertainty in inputs       |
| 🟡 **Hold** (High)   | Confident this is a hold — no action needed       |
| 🟡 **Hold** (Medium) | Neutral, some mixed signals                       |
| 🔴 **Sell** (High)   | Clear thesis break, data confirms                 |
| 🔴 **Sell** (Low)    | Warning signs, but not conclusive — watch closely |

**When the score is wrong, it should be understandably wrong.** The rationale and recent validation make errors explainable, not arbitrary.

---

**2. Conviction Score Engine (4-Factor Automated Model v4)**

> A single evolving score for every stock.
> **100% data-driven. No manual inputs required.**
> Score updates automatically when refreshed from Finnhub.

| Factor                   | Weight | Source  | Description                            |
| ------------------------ | ------ | ------- | -------------------------------------- |
| **1. Quality**           | 30%    | Finnhub | Profitability: EPS, margins, ROE, P/E  |
| **2. Earnings**          | 30%    | Finnhub | EPS growth trend, revenue growth       |
| **3. Analyst Consensus** | 25%    | Finnhub | Wall Street Buy/Hold/Sell distribution |
| **4. Momentum**          | 15%    | Finnhub | Price trend, 52-week range, beta       |

**Why 100% automated:**

- Removes friction of manual input
- Ensures consistency across users
- Objective data speaks for itself
- Users can still add notes externally if desired

**Example:** `NVDA Conviction Score: 82` (strong quality + bullish analyst consensus + positive earnings)

**Goal:** Directionally correct, explainable, and identifies both strong AND weak companies.

**Red Flag Logic:**

- If quality score < 25 AND earnings score < 20 → automatic cap at 25 (forces "Sell")
- Negative EPS and margins trigger quality penalties
- This ensures fundamentally weak companies (like PTON, BYND) show appropriately low scores

**Confidence derived from (v2 refined):**

| Confidence | Requirements                                                                              |
| ---------- | ----------------------------------------------------------------------------------------- |
| **High**   | Score >= 72 AND 3+ factors >= 60 AND Analyst >= 65 AND no weak factors                    |
| **Medium** | Default case - signals generally aligned                                                  |
| **Low**    | Mixed signals OR near threshold OR turnaround play (weak fundamentals + bullish analysts) |

**Visual Treatment:**

- **High** = Colored ring around posture badge
- **Medium** = Normal solid border
- **Low** = Dashed border (indicates uncertainty)

**4. Risk Warning System** (NEW)

> Traditional guardrails meet thesis-driven investing.
> Warnings are triggers for review, not automatic sell signals.

| Warning            | Trigger                  | Action                                              |
| ------------------ | ------------------------ | --------------------------------------------------- |
| **Concentration**  | Position > 15% portfolio | Review single-stock risk                            |
| **Critical Conc.** | Position > 25% portfolio | Urgent rebalancing consideration                    |
| **Loss Alert**     | Down > 8% from cost      | Review if thesis still valid                        |
| **Critical Loss**  | Down > 15% from cost     | Serious reassessment needed                         |
| **Gain Alert**     | Up > 25% from cost       | Consider taking partial profits if thesis weakening |

**Enhanced Decision Rules (Posture Logic):**

| Posture     | Trigger                                                                              | Philosophy                                     |
| ----------- | ------------------------------------------------------------------------------------ | ---------------------------------------------- |
| 🟢 **BUY**  | Conviction strengthening + Quality strong + Position below target                    | Add when signals align and room exists         |
| 🟡 **HOLD** | Conviction stable OR strengthening but fully sized OR weakening but no quality break | Default state                                  |
| 🔴 **TRIM** | Conviction weakening + Position oversized + No thesis break yet                      | Most underused action - realistic partial exit |
| 🔴 **SELL** | ANY: Quality deterioration OR Thesis broken OR Repeated misses (3+) OR Score < 30    | Thesis invalidation, not price pain            |

**Key Principle:** Sell is about thesis invalidation, not price pain.

---

**4. "Quiet Compounders" Discovery Engine**

> Finds stocks quietly executing without hype.
> Most investors discover stocks _after_ they explode.
> This finds them **before**.

| Element      | Description                                      |
| ------------ | ------------------------------------------------ |
| **Location** | "Suggested Finds" tab on main dashboard          |
| **Content**  | Algorithmically filtered candidates (5-10 shown) |
| **Tags**     | "Quiet Compounder", "Gold Mine", or "Turnaround" |
| **Action**   | One-click to add to your tracked stocks          |

**Algorithmic Filters for "Quiet Compounder":**

| Filter                     | Threshold                            |
| -------------------------- | ------------------------------------ |
| Beat estimates 4+ quarters | Last 4 earnings all beats            |
| Improving margins          | Operating margin up YoY              |
| Strong ROIC trend          | ROIC > 15% or consistently improving |
| Reasonable valuation       | P/E < 30 or PEG < 2                  |
| Insider buying             | Net positive insider transactions    |

**Why people will love it:** Most investors discover stocks after they explode. This finds them before.

---

**5. Portfolio Import**
Bulk import portfolio with position data for better decision context.

| Element               | Description                                             |
| --------------------- | ------------------------------------------------------- |
| **Input**             | CSV or Excel file from brokerage export                 |
| **Auto-detect**       | Smart column detection (ticker, shares, avg cost, name) |
| **Fallback**          | Manual column mapper if detection fails                 |
| **Position data**     | # Shares, Avg Cost → Portfolio Weight calculation       |
| **Dashboard display** | Weight badge (e.g., "15%") on each stock card           |

**Why Position Data Matters:**

| Data Point                   | Decision Value                                                                |
| ---------------------------- | ----------------------------------------------------------------------------- |
| **# Shares / Position Size** | A 15% position with "Sell" conviction = fire alarm. A 1% position = footnote. |
| **Avg Cost**                 | Psychological context. Being underwater affects clarity.                      |
| **Portfolio Weight**         | Prioritization. Focus attention on what matters most.                         |

---

**6. Stock Data API: Finnhub**
Essential for conviction scores to have meaning. Without real data, all scores default to neutral.

| Element            | Description                                   |
| ------------------ | --------------------------------------------- |
| **Provider**       | Finnhub.io (`https://finnhub.io/api/v1`)      |
| **Docs**           | https://finnhub.io/docs/api                   |
| **User setup**     | Free API key (stored in `.env`)               |
| **Rate limits**    | 60 calls/minute (generous for personal use)   |
| **Auto-fetch**     | Data pulled when adding new stocks            |
| **Manual refresh** | "Refresh All" button to update all stock data |
| **Caching**        | 15-minute client-side cache                   |

**Data Available from Finnhub:**

| Data Category     | Finnhub Endpoint        | Used For                          |
| ----------------- | ----------------------- | --------------------------------- |
| Quote & Price     | `/quote`                | Current price, change, high/low   |
| Company Info      | `/stock/profile2`       | Company name, sector, market cap  |
| Fundamentals      | `/stock/metric`         | P/E, EPS, margins, ROE, beta      |
| Analyst Consensus | `/stock/recommendation` | Buy/Hold/Sell rating distribution |

**Why Finnhub:**

- **Generous free tier** (60 calls/minute)
- **No CORS issues** (direct API access)
- **Comprehensive data** for all 4 conviction factors
- **Reliable and well-documented**

**Graceful Degradation:**

- If API fails: cached data used if available
- If stock not found: ticker saved with default scores (50)

---

### Out of Scope for MVP

| Feature                            | Why Deferred                                    |
| ---------------------------------- | ----------------------------------------------- |
| **News → Action Engine**           | Requires news API + LLM; planned for v2         |
| **Social media sentiment**         | No free API; would need scraping                |
| **Multiple watchlists/portfolios** | One list per user is enough for v1              |
| **Mobile optimization**            | Desktop-first; mobile is v2                     |
| **Push notifications/alerts**      | Manual daily check is the v1 model              |
| **Collaborative features**         | Each user is independent; no sharing in v1      |
| **Historical score tracking**      | Show current state only; history is v2          |
| **Backtesting**                    | Nice-to-have; not essential for thesis tracking |

---

### MVP Success Criteria

The MVP succeeds if, after 30 days:

1. **Still using it** — Became part of the daily/weekly routine
2. **Thesis entries exist** — Actually wrote down reasoning for holdings
3. **Acted on a signal** — At least one buy/hold/sell decision influenced by conviction score
4. **Found something via Suggested Finds** — Discovery seeded at least one new tracked stock
5. **Feels lighter** — Less cognitive load, not more

---

### Future Vision (Post-MVP)

**v2: News → Portfolio Action Engine**

> Turns news into suggested actions.
> Instead of flooding users with headlines, it:
>
> 1. Classifies news by theme
> 2. Maps themes → beneficiaries & losers
> 3. Shows historical analogs

**Example Output:**

```
NVIDIA raises capex guidance →
  Companies historically benefiting: CRDO, AVGO, AMAT, LRCX
  Typical 30-day performance after similar news: +6.1%
```

**v2 Enhancements:**

- **AI-Powered Gold Mine Discovery** - LLM analyzes market news to identify emerging investment themes and value chain opportunities (replaces static Gold Mines)
- News → Portfolio Action Engine (LLM-powered)
- Historical conviction score tracking
- Push notifications for conviction changes
- Score change alerts and thesis drift warnings
- Mobile-friendly views

**v3+ (If Wildly Successful):**

- LLM-assisted thesis writing and validation
- Integration with brokerage for position sizing
- Expanded to more users (if demand exists)
- Potential for productization (but not the goal)

**The Vision:**

> A system that turns information → probability → action.
> That's rare.
