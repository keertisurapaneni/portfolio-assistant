# Epic 3: Risk Monitoring & Alerts

Users receive automated risk warnings for concentration (>15%, >25%), losses (>8%, >15%), and significant gains (>25%) to support informed decision-making.

## Story 3.1: Portfolio Weight Calculation & Concentration Alerts

As an investor,
I want to see what percentage of my portfolio each stock represents and be alerted if any position is too concentrated,
So that I can maintain proper diversification and avoid excessive risk.

**Acceptance Criteria:**

**Given** I have imported position data (shares and avg cost) for my stocks
**When** the portfolio view calculates weights
**Then** each stock displays its portfolio weight as a percentage
**And** weight = (shares × current price) / total portfolio value × 100
**And** weights are rounded to 1 decimal place (e.g., "12.3%")

**Given** I have NOT imported position data (shares/cost)
**When** viewing my portfolio
**Then** portfolio weight shows "N/A" or is hidden
**And** concentration alerts are disabled for that stock
**And** I see a banner: "Import position data to enable portfolio weight and risk alerts"

**Given** a stock represents > 25% of my portfolio
**When** portfolio weights are calculated
**Then** the stock card displays a "🚨 HIGH CONCENTRATION" warning badge in red
**And** the badge appears prominently near the portfolio weight
**And** hovering/tapping the badge shows tooltip: "This position represents more than 25% of your portfolio. Consider rebalancing."

**Given** a stock represents between 15-25% of my portfolio
**When** portfolio weights are calculated
**Then** the stock card displays a "⚠️ MODERATE CONCENTRATION" warning badge in amber
**And** hovering/tapping the badge shows tooltip: "This position represents more than 15% of your portfolio. Monitor for over-concentration."

**Given** a stock represents < 15% of my portfolio
**When** portfolio weights are calculated
**Then** no concentration warning is displayed
**And** the portfolio weight is shown normally without special highlighting

**Given** portfolio composition changes (add/remove stocks, price updates)
**When** weights are recalculated
**Then** concentration warnings update dynamically
**And** a stock crossing the 15% or 25% threshold immediately shows/hides the appropriate warning

**Given** I have multiple stocks with concentration warnings
**When** viewing my portfolio
**Then** I can easily identify all at-risk positions by the warning badges
**And** stocks with warnings can optionally sort to the top for visibility

---

## Story 3.2: Loss & Gain Alert Detection

As an investor,
I want to be alerted when stocks have significant losses or gains from my purchase price,
So that I can consider taking action on positions that have moved substantially.

**Acceptance Criteria:**

**Given** I have imported avg cost for a stock
**When** the system calculates gain/loss
**Then** gain/loss % = ((current price - avg cost) / avg cost) × 100
**And** the calculation uses the current price from Story 2.2

**Given** a stock is down > 15% from my avg cost
**When** gain/loss is calculated
**Then** the stock card displays a "📉 LARGE LOSS" warning badge in red
**And** hovering/tapping shows tooltip: "Down {X}% from your cost basis of ${Y}. Review thesis."

**Given** a stock is down between 8-15% from my avg cost
**When** gain/loss is calculated
**Then** the stock card displays a "⚠️ LOSS" warning badge in amber
**And** hovering/tapping shows tooltip: "Down {X}% from your cost basis of ${Y}."

**Given** a stock is up > 25% from my avg cost
**When** gain/loss is calculated
**Then** the stock card displays a "🎯 LARGE GAIN" badge in green
**And** hovering/tapping shows tooltip: "Up {X}% from your cost basis of ${Y}. Consider taking profits or rebalancing."

**Given** a stock is between -8% and +25% from my avg cost
**When** gain/loss is calculated
**Then** no gain/loss warning badge is displayed
**And** the stock card shows the gain/loss % in small text (normal state)

**Given** I have NOT imported avg cost for a stock
**When** viewing the stock
**Then** gain/loss warnings are disabled
**And** the stock card shows current price but no gain/loss %
**And** no warning badges related to loss/gain appear

**Given** a stock crosses a threshold (e.g., -7% becomes -9%)
**When** price updates occur
**Then** the warning badge appears dynamically
**And** the badge is removed if the stock recovers above the threshold

**Given** I have both concentration AND loss/gain warnings on a stock
**When** viewing the stock card
**Then** both warning badges are displayed
**And** they are visually distinct and don't overlap
**And** the most severe warning appears first (left to right: 🚨 HIGH CONCENTRATION, 📉 LARGE LOSS)

---

## Story 3.3: Risk Warning Display on Stock Cards

As an investor,
I want risk warnings to be immediately visible on stock cards in the portfolio view,
So that I can quickly identify positions requiring attention without opening individual stock details.

**Acceptance Criteria:**

**Given** a stock has one or more active warnings (concentration, loss, gain)
**When** viewing the portfolio list
**Then** all warning badges for that stock appear on the stock card
**And** badges are positioned prominently (e.g., top-right corner or inline with portfolio weight)
**And** badges use distinct colors: red for critical, amber for moderate, green for gains

**Given** a stock has a HIGH CONCENTRATION warning (>25%)
**When** the stock card is rendered
**Then** I see the "🚨 HIGH CONCENTRATION" badge
**And** the badge is styled with red background and white text
**And** it's immediately scannable without interaction

**Given** a stock has a LARGE LOSS warning (>15%)
**When** the stock card is rendered
**Then** I see the "📉 LARGE LOSS" badge
**And** the badge is styled with red background and white text
**And** the stock row may have a subtle red left border for additional emphasis

**Given** a stock has a LARGE GAIN warning (>25%)
**When** the stock card is rendered
**Then** I see the "🎯 LARGE GAIN" badge
**And** the badge is styled with green background and white text
**And** this is informational, not a critical warning

**Given** a stock has multiple warnings
**When** the stock card is rendered
**Then** all applicable badges are displayed in order of severity:

1. 🚨 HIGH CONCENTRATION (critical)
2. 📉 LARGE LOSS (critical)
3. ⚠️ MODERATE CONCENTRATION (moderate)
4. ⚠️ LOSS (moderate)
5. 🎯 LARGE GAIN (positive)
   **And** the layout accommodates up to 3 badges without breaking the card design

**Given** I hover over a warning badge
**When** my cursor is over the badge
**Then** a tooltip appears with detailed information
**And** the tooltip includes:

- What triggered the warning
- Specific values (%, dollar amounts)
- Recommended action (if applicable)
  **And** the tooltip dismisses when I move my cursor away

**Given** I click on a stock card with warnings
**When** the stock detail slide-over opens
**Then** the warnings are also visible in the detail view
**And** the detail view provides expanded context (e.g., chart showing decline, position size in dollars)

**Given** I have sorted or filtered my portfolio
**When** warnings are present
**Then** an option exists to "Show stocks with warnings first"
**And** this sorting brings all at-risk positions to the top of the list
**And** the sort preference persists across page refreshes

**Given** no stocks in my portfolio have warnings
**When** viewing the portfolio
**Then** no warning badges appear
**And** the portfolio view is clean and minimal
**And** the UI doesn't allocate space for non-existent warnings

**Given** warnings are calculated on page load
**When** the portfolio initially renders
**Then** warnings appear within 500ms of the stock data loading
**And** there's no flickering or layout shift when warnings appear
**And** warnings are recalculated whenever prices update (Story 2.8)

---
