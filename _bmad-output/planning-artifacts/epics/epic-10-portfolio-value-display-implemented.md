# Epic 10: Portfolio Value Display (IMPLEMENTED)

Users can see their position value per stock and total portfolio value when they've entered share counts.

**Status:** ✅ Fully implemented

**New FRs covered:**

- FR69: Display per-stock position value (shares × current price) on stock cards
- FR70: Display total portfolio value in the dashboard header
- FR71: Display total daily P&L change in dollar terms
- FR72: Values only appear when user has entered share data

## Story 10.1: Portfolio Value on Cards and Header

As an investor,
I want to see how much each position is worth and my total portfolio value,
So that I understand my exposure in dollar terms.

**Acceptance Criteria:**

**Given** I have entered share counts for my stocks
**When** viewing the portfolio
**Then** each stock card shows "X shares · $Y,YYY" next to the price
**And** the dashboard header shows "Your Holdings $XXX,XXX"
**And** the header shows daily P&L change (e.g., "+$1,230 today" or "-$850 today")
**And** values are hidden if no share data is entered

---
