# Epic 11: News Integration (IMPLEMENTED)

Users see recent news headlines on stock cards and in the AI analysis context.

**Status:** ✅ Fully implemented

**New FRs covered:**

- FR73: Display most recent news headline on each stock card
- FR74: News headlines are clickable links to the source article
- FR75: AI analysis considers recent news when making BUY/SELL decisions
- FR76: News is filtered for company relevance (removes generic market news)

## Story 11.1: News on Stock Cards

As an investor,
I want to see the latest news for each stock on the card,
So that I have context for price movements at a glance.

**Acceptance Criteria:**

**Given** a stock has recent news from Finnhub
**When** viewing the portfolio
**Then** the most recent headline appears at the bottom of the card
**And** the headline is a clickable link opening in a new tab
**And** a relative timestamp shows when the article was published (e.g., "3h ago")

---
