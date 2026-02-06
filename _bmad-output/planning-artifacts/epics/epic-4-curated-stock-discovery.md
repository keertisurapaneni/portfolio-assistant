# Epic 4: Curated Stock Discovery

Users discover high-quality stock ideas through curated "Quiet Compounders" and "Gold Mines" suggestions with one-click portfolio addition.

## Story 4.1: Curated Stock Suggestions Data Structure

As a system administrator,
I want a maintainable data structure for stock suggestions with archetypes and key metrics,
So that the Suggested Finds tab can display high-quality, curated investment ideas.

**Acceptance Criteria:**

**Given** the system needs to display curated suggestions
**When** the suggestions data structure is defined
**Then** it includes the following fields for each suggestion:

- `ticker` (string, required)
- `companyName` (string, required)
- `archetype` (enum: "QUIET_COMPOUNDER" | "GOLD_MINE", required)
- `description` (string, 1-2 sentences explaining why it fits the archetype)
- `theme` (string, optional, for Gold Mines - e.g., "AI Infrastructure")
- `metrics` (object with optional fields: `roic`, `margin`, `cagr`)
- `isDismissed` (boolean, tracks user dismissals)
  **And** the data structure supports easy addition of new suggestions

**Given** "Quiet Compounders" archetype is defined
**When** curating stocks for this category
**Then** stocks are selected based on criteria:

- Consistent profitability (ROIC > 15%)
- Boring or unglamorous industries
- Low volatility / stable businesses
- Long track record of steady growth
  **And** example stocks: ODFL (Old Dominion Freight), COST (Costco), WM (Waste Management)

**Given** "Gold Mines" archetype is defined
**When** curating stocks for this category
**Then** stocks are selected based on criteria:

- High-growth potential in emerging themes
- Strong competitive moats
- Explosive revenue/earnings growth
- Thematic focus (AI, EV, Cloud, etc.)
  **And** example stocks: NVDA (AI Infrastructure), TSLA (EV/Energy), SHOP (E-commerce)

**Given** the initial suggestion pool is created
**When** the system is deployed
**Then** it contains at least:

- 10-15 "Quiet Compounders"
- 10-15 "Gold Mines" across 3-4 themes
  **And** suggestions are stored in a JSON file or database table for easy maintenance

**Given** a suggestion includes metrics
**When** displaying the suggestion
**Then** metrics are formatted as:

- ROIC: percentage (e.g., "20%")
- Margin: percentage (e.g., "15%")
- CAGR: percentage with growth indicator (e.g., "+25%")
  **And** missing metrics show as "N/A" or are hidden

**Given** suggestions need to be updated over time
**When** an admin wants to add/remove suggestions
**Then** they can edit the suggestions data source (JSON file or DB)
**And** changes reflect immediately on next page load
**And** no code changes are required to update the suggestion pool

---

## Story 4.2: Suggested Finds Tab UI

As an investor,
I want to browse curated stock ideas organized by archetype with expandable details,
So that I can discover high-quality investments aligned with my strategy.

**Acceptance Criteria:**

**Given** I am on the Portfolio Assistant dashboard
**When** I click the "Suggested Finds" tab
**Then** the tab becomes active and displays the Suggested Finds view
**And** the "My Portfolio" tab becomes inactive
**And** the URL updates to reflect the active tab (for bookmarking)

**Given** I am viewing the Suggested Finds tab
**When** the page loads
**Then** I see two sections:

1. "🏔️ QUIET COMPOUNDERS" header
2. "💎 GOLD MINES" header
   **And** each section displays 3-5 suggestions initially
   **And** sections are visually distinct with section headers

**Given** I am viewing a suggestion in the Quiet Compounders section
**When** the suggestion row is rendered
**Then** I see:

- Ticker symbol with Yahoo Finance link (🔗 icon)
- Company name
- Description (always visible, 1-2 sentences)
- Expand toggle ([▶] or [▼])
- [+ Add] button
  **And** the layout is clean and scannable (two-line row format per UX spec)

**Given** I am viewing a suggestion in the Gold Mines section
**When** the suggestion row is rendered
**Then** I see all the same elements as Quiet Compounders
**And** additionally see the theme label (e.g., "AI Infrastructure Theme")
**And** theme is displayed as a subtle badge or tag above the description

**Given** a suggestion is in collapsed state (default)
**When** viewing the suggestion
**Then** I see ticker, name, description, and action buttons
**And** metrics are hidden
**And** the expand toggle shows [▶] (right arrow)

**Given** I click the expand toggle on a suggestion
**When** the toggle is clicked
**Then** the suggestion expands to show metrics
**And** the toggle changes to [▼] (down arrow)
**And** metrics are displayed as colored pills/badges:

- ROIC badge in emerald/green
- Margin badge in blue
- CAGR badge in violet/purple
  **And** the expansion animates smoothly (200-300ms)

**Given** I click the expand toggle on an already-expanded suggestion
**When** the toggle is clicked again
**Then** the suggestion collapses back to the default state
**And** metrics are hidden again
**And** the toggle changes back to [▶]

**Given** there are more than 5 suggestions per archetype
**When** viewing a section
**Then** I see a "Show More" link at the bottom of each section
**And** clicking it reveals 5 additional suggestions
**And** the link updates to show count: "Show More (10 remaining)"

**Given** all suggestions for an archetype are visible
**When** viewing the section
**Then** the "Show More" link is hidden or changes to "Show Less"
**And** clicking "Show Less" collapses back to the initial 5 suggestions

**Given** I click the Yahoo Finance link (🔗) next to a ticker
**When** the link is clicked
**Then** a new browser tab opens to finance.yahoo.com/quote/{TICKER}
**And** I remain on the Suggested Finds tab in the original window

---

## Story 4.3: Dismiss & Replace Suggestions

As an investor,
I want to dismiss suggestions I'm not interested in so they don't clutter my feed,
So that the Suggested Finds tab remains relevant and useful.

**Acceptance Criteria:**

**Given** I am viewing a suggestion row
**When** I hover over the row
**Then** a dismiss button (✕ icon) appears in the top-right corner
**And** the button is styled subtly (gray, small) to avoid visual clutter

**Given** I click the dismiss button on a suggestion
**When** the button is clicked
**Then** a confirmation tooltip appears: "Hide this suggestion?"
**And** the tooltip has two options: "Yes, hide" and "Cancel"
**And** the tooltip remains visible until I make a selection or click outside

**Given** I confirm dismissal ("Yes, hide")
**When** the confirmation is clicked
**Then** the suggestion row fades out with animation (300ms)
**And** the suggestion is removed from view
**And** the dismissed ticker is marked with `isDismissed: true` in the data
**And** the dismissal persists across page refreshes (stored in localStorage)

**Given** I cancel dismissal
**When** "Cancel" is clicked or I click outside the tooltip
**Then** the confirmation tooltip closes
**And** the suggestion remains visible
**And** no changes are made to the data

**Given** I have dismissed a suggestion
**When** the section is rendered on subsequent page loads
**Then** the dismissed suggestion does NOT appear
**And** a new suggestion from the pool replaces it to maintain 3-5 visible suggestions per section
**And** dismissed suggestions remain hidden indefinitely (until data is reset)

**Given** I have dismissed multiple suggestions
**When** viewing the Suggested Finds tab
**Then** each dismissed suggestion is replaced with the next undismissed suggestion from the pool
**And** I always see 3-5 active (non-dismissed) suggestions per section
**And** if the pool is exhausted, a message appears: "You've reviewed all {archetype} suggestions. Check back later for new ideas."

**Given** I want to reset my dismissed suggestions
**When** I click a "Reset Dismissed Suggestions" button in settings or at the bottom of the tab
**Then** a confirmation modal appears: "This will restore all {N} dismissed suggestions. Continue?"
**And** confirming resets all `isDismissed` flags to `false`
**And** all previously dismissed suggestions reappear in the feed

**Given** dismissed suggestions are stored in localStorage
**When** I switch devices or browsers
**Then** my dismissals do NOT carry over (localStorage is device-specific)
**And** I see the full suggestion pool on the new device
**And** this is acceptable for MVP (cloud sync of dismissals is V2)

---

## Story 4.4: One-Click Add to Portfolio

As an investor,
I want to add a suggested stock to my portfolio with one click,
So that I can quickly act on interesting ideas without manual ticker entry.

**Acceptance Criteria:**

**Given** I am viewing a suggestion in the Suggested Finds tab
**When** I see the [+ Add] button
**Then** the button is prominently visible on the right side of the suggestion row
**And** it's styled as a primary action button (green or blue)
**And** the button text reads "+ Add" or "+ Add to Portfolio"

**Given** the suggested stock is NOT in my portfolio
**When** I click the [+ Add] button
**Then** the stock is immediately added to my portfolio
**And** the button changes to "✓ Added" with a checkmark
**And** the button becomes disabled (non-clickable)
**And** a success toast appears: "{TICKER} added to portfolio"
**And** the stock appears in the "My Portfolio" tab with default scores (50/100)

**Given** the suggested stock is already in my portfolio
**When** the suggestion row is rendered
**Then** the [+ Add] button is disabled
**And** the button text shows "✓ In Portfolio"
**And** the button is styled with a subtle gray to indicate it's not actionable
**And** hovering over the button shows tooltip: "This stock is already in your portfolio"

**Given** I add a stock via the [+ Add] button
**When** the stock is added
**Then** the system automatically triggers a data fetch for that stock (auto-refresh from Story 2.8)
**And** conviction scores and data populate within 3-5 seconds
**And** I can immediately navigate to the Portfolio tab to see the new stock

**Given** I add a stock and then immediately click the Portfolio tab
**When** I view the Portfolio tab
**Then** I see the newly added stock in my portfolio list
**And** the stock shows loading indicators while data is fetching
**And** scores populate when the API calls complete

**Given** I have dismissed a suggestion
**When** viewing the suggestion (before dismissing)
**Then** I can still click [+ Add] to add it to my portfolio
**And** adding the stock does NOT prevent dismissal
**And** dismissal does NOT remove the stock from portfolio
**And** these are independent actions

**Given** I have added a stock to my portfolio
**When** I return to the Suggested Finds tab later
**Then** the suggestion for that stock still shows "✓ In Portfolio"
**And** the disabled state persists across page refreshes
**And** if I remove the stock from my portfolio, the [+ Add] button becomes active again

**Given** I click [+ Add] and the operation fails (network error, etc.)
**When** the error occurs
**Then** the button returns to the "+ Add" state
**And** an error toast appears: "Failed to add {TICKER}. Please try again."
**And** I can retry by clicking the button again

**Given** I add multiple stocks in quick succession
**When** clicking [+ Add] on several suggestions
**Then** each stock is added independently
**And** multiple success toasts appear (stacked or queued)
**And** all stocks appear in my portfolio
**And** auto-refresh happens for each stock independently

---
