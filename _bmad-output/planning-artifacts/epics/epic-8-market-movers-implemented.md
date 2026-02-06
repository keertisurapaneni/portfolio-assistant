# Epic 8: Market Movers (IMPLEMENTED)

Users can view top market gainers and losers in a dedicated tab, fetched dynamically from Yahoo Finance.

**Status:** ✅ Fully implemented

**New FRs covered:**

- FR60: Display top 25 gainers and top 25 losers in sortable tables
- FR61: Fetch market mover data from Yahoo Finance Screener via Edge Function
- FR62: Allow sorting by Price, Change ($), and Change (%) columns
- FR63: Provide Yahoo Finance links for each mover
- FR64: Show last-updated timestamp and manual refresh button

## Story 8.1: Market Movers Tab

As an investor,
I want a "Market Movers" tab showing today's biggest gainers and losers,
So that I can spot opportunities and risks across the broader market.

**Acceptance Criteria:**

**Given** I click the "Market Movers" tab
**When** the tab loads
**Then** I see two tables: "Top Gainers" and "Top Losers"
**And** each table shows Symbol, Name, Price, Change ($), Change (%)
**And** columns with numerical values are sortable (ascending/descending)
**And** each row links to Yahoo Finance for the stock
**And** a timestamp shows when data was last fetched

---
