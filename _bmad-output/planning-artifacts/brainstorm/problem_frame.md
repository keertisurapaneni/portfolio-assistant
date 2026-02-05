# Problem Frame: Personal Investing Decision-Support Website

## Problem Statement

We spend hours researching stocks across scattered tools (screeners, news sites, earnings reports, spreadsheets) yet still miss opportunities, hold losers too long, and forget why we bought something in the first place. There's no single place that surfaces high-conviction opportunities, tracks our thesis validity, and tells us when to act.

## Target Users

- **Primary:** Keerti, husband, and close friends/family (10 users max)
- **Profile:** Active retail investors, intermediate skill, time-constrained, long-term oriented
- **Not:** Day traders, institutions, or the general public

## Success Criteria

1. Reduce research-to-decision time by 50% (from ~2hrs to <1hr per stock)
2. Surface at least 3 actionable "Quiet Compounder" or "Gold Mine" candidates per month we wouldn't have found manually
3. Catch earnings surprises within 24hrs with clear hold/trim/add guidance
4. Zero missed sells on broken thesis (tracked via Outcome Tracker)

## Explicit Non-Goals

- **Not** a brokerage or trade execution platform
- **Not** real-time trading signals or technical analysis
- **Not** social/community features beyond our small group
- **Not** mobile-first (desktop is fine)
- **Not** comprehensive portfolio tracking (we have brokerages for that)

## Key Risks

| Risk                                 | Mitigation                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| Data costs (market data APIs)        | Start with free tiers (Yahoo Finance, Alpha Vantage); cap at $50/mo            |
| Conviction Score becomes noise       | Backtest scoring model against our actual past decisions before trusting it    |
| Scope creep into "build a Bloomberg" | Ruthlessly enforce the 5-user constraint; if feature doesn't help us 5, cut it |
| Stale data → bad decisions           | Clear "last updated" timestamps; fail loudly if data is >24hrs old             |

## Core Features (MVP)

| Feature                             | What It Does                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| **Discovery: Quiet Compounders**    | Surfaces boring, steady growers with low volatility + consistent ROIC            |
| **Discovery: Gold Mine Mode**       | Finds beaten-down quality names with >30% upside to fair value                   |
| **Conviction Score**                | Weighted score (valuation, quality, momentum, thesis strength) → Buy/Hold/Sell   |
| **Earnings → Outcome Tracker**      | Logs our buy thesis, tracks earnings vs. expectations, flags thesis breaks       |
| **News/Earnings → Action Insights** | Parses key events, maps to our holdings, suggests "review needed" or "no action" |
