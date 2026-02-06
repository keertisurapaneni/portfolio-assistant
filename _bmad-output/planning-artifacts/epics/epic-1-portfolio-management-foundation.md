# Epic 1: Portfolio Management Foundation

Users can build and maintain their investment portfolio with ticker entry, CSV/Excel import with smart column detection, and portfolio-wide operations.

## Story 1.1: Manual Ticker Entry

As an investor,
I want to add stocks to my portfolio by entering ticker symbols,
So that I can quickly build my portfolio without uploading files.

**Acceptance Criteria:**

**Given** I am on the Portfolio Assistant dashboard
**When** I click the "Add Tickers" button in the header
**Then** a modal opens with a text input field for ticker entry
**And** I can enter comma-separated tickers (e.g., "AAPL, MSFT, GOOG")

**Given** I have entered valid ticker symbols
**When** I click "Add to Portfolio"
**Then** the tickers are added to my portfolio
**And** the modal closes
**And** I see the new stocks in my portfolio list with default scores (50/100)
**And** duplicate tickers are ignored with a warning message

**Given** I have entered invalid ticker symbols
**When** I click "Add to Portfolio"
**Then** I see an error message indicating which tickers are invalid
**And** valid tickers are still added to the portfolio
**And** the modal remains open so I can correct invalid entries

**Given** I am in the Add Tickers modal
**When** I click "Cancel" or the close (X) button
**Then** the modal closes without adding any tickers
**And** no changes are made to my portfolio

---

## Story 1.2: Stock Display & Removal

As an investor,
I want to view all my portfolio stocks in a scannable format and remove individual stocks,
So that I can maintain an up-to-date portfolio of stocks I'm actively tracking.

**Acceptance Criteria:**

**Given** I have stocks in my portfolio
**When** I view the "My Portfolio" tab
**Then** each stock is displayed as a card-style row showing:

- Ticker symbol and company name
- Portfolio weight (% of total, if position data available)
- Posture badge (Buy/Hold/Sell with confidence)
- Conviction score (0-100)
- Score delta (↑/↓/→ change since last update)
- 1-line rationale summary
  **And** stocks are sorted by conviction score (highest first) by default

**Given** I click on a stock row
**When** the click is registered
**Then** a slide-over panel opens showing detailed stock information
**And** the main portfolio view remains visible behind the panel

**Given** I hover over a stock card
**When** my cursor is over the card
**Then** the card highlights slightly to indicate interactivity
**And** I see a "•••" (more actions) button appear

**Given** I click the "•••" button on a stock card
**When** the more actions menu opens
**Then** I see a "Remove from Portfolio" option
**And** clicking it removes the stock immediately
**And** a confirmation toast appears: "{TICKER} removed from portfolio"
**And** the portfolio view updates to reflect the removal

**Given** my portfolio is empty
**When** I view the "My Portfolio" tab
**Then** I see an empty state message: "Your portfolio is empty. Add stocks to get started."
**And** I see a prominent "Add Tickers" button

---

## Story 1.3: Portfolio Bulk Operations

As an investor,
I want to clear my entire portfolio in one action,
So that I can start fresh without removing stocks one by one.

**Acceptance Criteria:**

**Given** I have stocks in my portfolio
**When** I view the portfolio header area
**Then** I see a "Clear Portfolio" button or link
**And** it is visually distinct but not prominently placed (to avoid accidental clicks)

**Given** I click "Clear Portfolio"
**When** the action is triggered
**Then** a confirmation modal appears with the message: "Are you sure you want to remove all {N} stocks from your portfolio? This cannot be undone."
**And** the modal has "Cancel" and "Clear All Stocks" buttons
**And** the "Clear All Stocks" button is styled with a warning color (red)

**Given** I click "Cancel" in the confirmation modal
**When** the button is clicked
**Then** the modal closes
**And** no stocks are removed from my portfolio

**Given** I click "Clear All Stocks" in the confirmation modal
**When** the button is clicked
**Then** all stocks are removed from my portfolio
**And** the portfolio tab shows the empty state
**And** a toast notification appears: "Portfolio cleared. {N} stocks removed."
**And** localStorage is updated to reflect the empty portfolio

**Given** I clear my portfolio
**When** I refresh the browser
**Then** my portfolio remains empty (change persisted)

---

## Story 1.4: CSV/Excel Import with Smart Detection

As an investor,
I want to upload a CSV or Excel file from my brokerage and have the system automatically detect the ticker column,
So that I can quickly import my entire portfolio without manual mapping.

**Acceptance Criteria:**

**Given** I am in the Add Tickers modal
**When** I click the "Import File" tab
**Then** I see a file upload area with instructions: "Upload CSV or Excel from your brokerage"
**And** I see supported formats listed: ".csv, .xlsx"
**And** I see text: "We'll auto-detect: Ticker, Shares, Avg Cost, Name"

**Given** I am in the Import File tab
**When** I click the upload area or drag a file onto it
**Then** a file picker opens (for click) or accepts the dropped file (for drag)
**And** only .csv and .xlsx files are accepted
**And** other file types show an error: "Unsupported file type. Please upload .csv or .xlsx"

**Given** I have uploaded a valid CSV/Excel file with standard column names
**When** the file is processed
**Then** the system detects columns matching: ["ticker", "symbol", "stock"], ["shares", "quantity", "qty"], ["cost", "price", "avg cost", "average cost"], ["name", "description", "company"]
**And** a preview modal appears showing detected columns and first 5 rows
**And** I see a summary: "{N} stocks found"

**Given** the preview modal is showing detected data
**When** I click "Import {N} stocks"
**Then** the stocks are added to my portfolio
**And** the import modal closes
**And** the Add Tickers modal closes
**And** I return to the main portfolio view
**And** I see a success toast: "Successfully imported {N} stocks"
**And** the portfolio triggers an auto-refresh to fetch current data for imported stocks

**Given** the file upload succeeds but detection is uncertain
**When** the system cannot confidently detect all required columns
**Then** the system proceeds to manual column mapping (Story 1.5)
**And** does NOT auto-import

**Given** I upload a file with 0 valid tickers
**When** the file is processed
**Then** I see an error message: "No valid tickers found in file. Please check your file format."
**And** the import modal remains open so I can try again

---

## Story 1.5: Manual Column Mapping

As an investor,
I want to manually map columns when auto-detection fails,
So that I can still import my portfolio from non-standard file formats.

**Acceptance Criteria:**

**Given** auto-detection has failed or been skipped
**When** the column mapper interface loads
**Then** I see all column headers from my uploaded file as options in dropdowns
**And** I see four mapping fields: "Ticker (required)", "Shares (optional)", "Avg Cost (optional)", "Name (optional)"
**And** each field has a dropdown pre-selected with the system's best guess (or blank)

**Given** I am viewing the column mapper
**When** I select a column for "Ticker (required)"
**Then** a preview table updates below showing sample data from that column
**And** I can see the first 5 rows to verify my selection
**And** the preview shows: Ticker | Shares | Avg Cost | Name for all mapped columns

**Given** I have selected only the Ticker column
**When** I click "Import {N} stocks"
**Then** stocks are imported with ticker only
**And** shares, avg cost, and name fields are left empty/null for those stocks
**And** the system proceeds with import as normal

**Given** I have not selected a Ticker column
**When** I attempt to click "Import"
**Then** the Import button is disabled
**And** I see helper text: "Ticker column is required to import"

**Given** I select columns and review the preview
**When** I am satisfied with the mapping
**Then** I click "Import {N} stocks"
**And** the import proceeds using my manual mappings
**And** success toast appears: "Successfully imported {N} stocks with custom mapping"

**Given** I am in the column mapper
**When** I click "Cancel"
**Then** the mapper closes
**And** I return to the Import File tab
**And** no stocks are imported

---
