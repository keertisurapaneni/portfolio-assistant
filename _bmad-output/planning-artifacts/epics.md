---
stepsCompleted:
  [
    step-01-validate-prerequisites,
    step-02-design-epics,
    step-03-create-stories,
    step-04-final-validation,
  ]
inputDocuments:
  - planning-artifacts/prd.md
  - planning-artifacts/architecture.md
  - planning-artifacts/ux-design-specification.md
project_name: 'portfolio-assistant'
date: '2026-02-05'
author: 'keerti'
workflowStatus: 'complete'
---

# Portfolio Assistant - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for Portfolio Assistant, decomposing the requirements from the PRD, UX Design, and Architecture into implementable stories.

## Requirements Inventory

### Functional Requirements

**Portfolio Management (7 FRs):**

- FR1: Users can add stocks to their portfolio by entering ticker symbols
- FR2: Users can import portfolios from CSV or Excel files
- FR3: Users can view all stocks in their portfolio with key metrics
- FR4: Users can remove individual stocks from their portfolio
- FR5: Users can clear their entire portfolio
- FR6: System auto-detects columns (ticker, shares, avg cost, name) from uploaded files
- FR7: Users can manually map columns if auto-detection fails

**Conviction Scoring & Analysis (7 FRs):**

- FR8: System calculates conviction scores (0-100) for each stock using 4 automated factors
- FR9: System determines posture (Buy/Hold/Sell) based on conviction score
- FR10: System determines confidence level (High/Medium/Low) based on signal alignment
- FR11: Users can view detailed score breakdown by factor (Quality, Earnings, Analyst, Momentum)
- FR12: System displays score explanations via tooltips for each factor
- FR13: System tracks conviction score changes over time (displays delta)
- FR14: System generates 2-3 bullet rationale for each conviction score

**Risk & Warning System (4 FRs):**

- FR15: System detects concentration risk (position > 15% or > 25% of portfolio)
- FR16: System detects loss alerts (down > 8% or > 15% from cost basis)
- FR17: System detects gain alerts (up > 25% from cost basis)
- FR18: Users can view warnings prominently on affected stock cards

**Suggested Finds & Discovery (6 FRs):**

- FR19: System displays curated "Quiet Compounders" suggestions with expandable details
- FR20: System displays curated "Gold Mines" suggestions with theme context
- FR21: Users can dismiss individual suggestion cards
- FR22: System replaces dismissed suggestions with new ones from the pool
- FR23: Users can add suggested stocks to their portfolio with one click
- FR24: System displays stock descriptions and key metrics for suggestions

**Stock Data Integration (7 FRs):**

- FR25: System fetches real-time stock quotes from Finnhub API
- FR26: System fetches company fundamentals (P/E, margins, ROE, EPS) from Finnhub
- FR27: System fetches Wall Street analyst recommendations from Finnhub
- FR28: System fetches quarterly earnings history from Finnhub
- FR29: System caches API responses for performance
- FR30: Users can manually refresh data for all stocks
- FR31: System provides Yahoo Finance links for each ticker

**User Authentication & Access (8 FRs):**

- FR32: Users can access the full app as guests without creating an account
- FR33: Guest users' data persists in browser localStorage
- FR34: Users can sign up with email and password
- FR35: Users can log in with email and password
- FR36: Users can log out
- FR37: Authenticated users' portfolios sync to cloud database
- FR38: System prompts guest users to import their local portfolio when signing up
- FR39: System migrates guest portfolio data to cloud upon signup

**User Interface & Navigation (5 FRs):**

- FR40: Users can navigate between "My Portfolio" and "Suggested Finds" tabs
- FR41: Users can view detailed stock information in slide-over panel
- FR42: Users can close slide-over panels to return to main view
- FR43: System displays guest mode banner for unauthenticated users
- FR44: System displays user account menu for authenticated users

**Data Management & Persistence (4 FRs):**

- FR45: System persists portfolio data in localStorage for guest users
- FR46: System persists portfolio data in Supabase for authenticated users
- FR47: System enforces Row Level Security (users only see their own data)
- FR48: System maintains data consistency between client and server

**Total: 48 Functional Requirements**

---

### Non-Functional Requirements

**Performance (7 NFRs):**

- NFR1: Initial page load completes within 3 seconds on typical broadband
- NFR2: Stock data refresh completes within 5 seconds for a 10-stock portfolio
- NFR3: Tab navigation (Portfolio ↔ Suggested Finds) is instantaneous (<100ms)
- NFR4: CSV/Excel import processes within 2 seconds for files up to 100 stocks
- NFR5: System caches Finnhub API responses for 5 minutes to minimize rate limit hits
- NFR6: Batch API calls where possible to reduce total request count
- NFR7: Display cached data immediately while fetching fresh data in background

**Security (9 NFRs):**

- NFR8: All portfolio data encrypted at rest in Supabase
- NFR9: All API communication over HTTPS only
- NFR10: Finnhub API keys stored in environment variables, never in client code
- NFR11: Supabase API keys use anon key with Row Level Security (no service key in client)
- NFR12: Passwords hashed with bcrypt before storage (handled by Supabase Auth)
- NFR13: Authenticated users can only access their own portfolio data (RLS enforced)
- NFR14: Guest users' localStorage data stays in browser, never transmitted
- NFR15: Rate limiting handled gracefully with user-friendly error messages
- NFR16: No sensitive data (API keys, user credentials) logged or exposed in browser console

**Integration Reliability (6 NFRs):**

- NFR17: System handles API failures gracefully (displays last cached data + error banner)
- NFR18: System retries failed API calls with exponential backoff (max 3 retries)
- NFR19: System displays clear error messages when ticker is invalid or not found
- NFR20: System continues functioning if API rate limit exceeded (uses cached data)
- NFR21: System falls back to localStorage if Supabase connection fails
- NFR22: System queues portfolio updates locally if offline, syncs when connection restored

**Usability (6 NFRs):**

- NFR23: System works on latest versions of Chrome, Firefox, Safari, Edge
- NFR24: System is responsive on desktop (1024px+) and tablet (768px+)
- NFR25: Mobile support not required for MVP (can be awkward on small screens)
- NFR26: All error states display user-friendly messages (no raw error codes)
- NFR27: System never crashes - all failures handled gracefully
- NFR28: Loading states clearly indicate progress for operations >1 second

**Total: 28 Non-Functional Requirements**

---

### Additional Requirements

**From Architecture Document:**

**Infrastructure & Deployment:**

- Supabase project setup (PostgreSQL database + Auth + Edge Functions)
- Database schema with Row Level Security (RLS) policies
- Edge Function deployment for secure API proxy (`fetch-stock-data`)
- Vercel frontend deployment with public URL
- Environment variable configuration (.env for API keys)
- Server-side caching table (`stock_cache`) with 15-minute TTL

**Technical Implementation:**

- Storage adapter pattern (interface + localStorage impl + Supabase impl)
- Hybrid storage strategy (seamless guest→auth migration)
- Edge Function logic: cache check → Finnhub fetch → cache update
- API contracts for Edge Function (request/response format)
- Database migrations (initial schema + RLS policies + indexes)
- Immutable state updates (React best practices)

**Integration Requirements:**

- Finnhub API integration (4 endpoints: quote, metrics, recommendations, earnings)
- Supabase client setup in frontend
- Edge Function secret management (Finnhub API key)
- CORS and security headers configuration

**From UX Design Document:**

**UI Implementation:**

- 2-tab SPA structure (My Portfolio, Suggested Finds)
- Slide-over panel for stock details
- Modal components (Add Tickers with tabs, Import Portfolio, Add Earnings)
- Guest mode banner with "Try without signup" message
- Account menu dropdown for authenticated users

**Responsive Design:**

- Desktop-first design (1024px+ primary)
- Tablet support (768px+)
- Mobile optimization deferred to V2

**Visual Design:**

- Clean, modern, minimal aesthetic
- Neutral color palette with meaningful color signals only
- Confidence level visual distinction (ring for High, dashed for Low)
- Info icon tooltips for score explanations

**Brownfield Context:**

- **Existing codebase at:** `/Users/ksrisurapaneni/Git-RV/stock-website/app`
- **No starter template needed** - building on existing React+Vite project
- **Existing features to preserve:** Conviction engine, dashboard UI, import functionality
- **Enhancement approach:** Add Supabase backend + auth layer to existing frontend

---

### FR Coverage Map

**Epic 1 (Portfolio Management Foundation):**

- FR1: Add stocks by ticker symbol
- FR2: Import portfolios from CSV/Excel
- FR3: View all stocks with key metrics
- FR4: Remove individual stocks
- FR5: Clear entire portfolio
- FR6: Auto-detect columns from uploaded files
- FR7: Manual column mapping fallback

**Epic 2 (Automated Conviction Intelligence):**

- FR8: Calculate conviction scores (0-100) using 4 factors
- FR9: Determine posture (Buy/Hold/Sell)
- FR10: Determine confidence level (High/Medium/Low)
- FR11: View detailed score breakdown by factor
- FR12: Display score explanations via tooltips
- FR13: Track conviction score changes (delta)
- FR14: Generate 2-3 bullet rationale
- FR25: Fetch real-time stock quotes from Finnhub
- FR26: Fetch company fundamentals from Finnhub
- FR27: Fetch analyst recommendations from Finnhub
- FR28: Fetch quarterly earnings history from Finnhub
- FR29: Cache API responses for performance
- FR30: Manual refresh for all stocks
- FR31: Provide Yahoo Finance links

**Epic 3 (Risk Monitoring & Alerts):**

- FR15: Detect concentration risk (>15%, >25%)
- FR16: Detect loss alerts (>8%, >15%)
- FR17: Detect gain alerts (>25%)
- FR18: Display warnings on affected stock cards

**Epic 4 (Curated Stock Discovery):**

- FR19: Display "Quiet Compounders" suggestions
- FR20: Display "Gold Mines" suggestions with themes
- FR21: Dismiss individual suggestion cards
- FR22: Replace dismissed suggestions
- FR23: One-click add to portfolio
- FR24: Display descriptions and key metrics

**Epic 5 (Cloud Sync & Multi-Device Access):**

- FR32: Guest access without account
- FR33: Guest data in browser localStorage
- FR34: Sign up with email/password
- FR35: Log in with email/password
- FR36: Log out
- FR37: Cloud portfolio sync for auth users
- FR38: Prompt guest users to import on signup
- FR39: Migrate guest portfolio on signup
- FR43: Display guest mode banner
- FR44: Display user account menu
- FR45: Persist data in localStorage (guests)
- FR46: Persist data in Supabase (auth users)
- FR47: Enforce Row Level Security
- FR48: Maintain client-server consistency

**Epic 6 (Production Deployment & Infrastructure):**

- FR40: Navigate between tabs
- FR41: View stock details in slide-over
- FR42: Close slide-over panels
- NFR1-NFR28: All non-functional requirements (performance, security, reliability, usability)
- Infrastructure: Supabase setup, Edge Functions, Vercel deployment

**Total Coverage: 48 FRs + 28 NFRs + Infrastructure Requirements ✅**

---

## Epic List

### Epic 1: Portfolio Management Foundation

Users can build and maintain their investment portfolio with ticker entry, CSV/Excel import with smart column detection, and portfolio-wide operations.

**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6, FR7

**User Value:** Complete portfolio management capability with both manual and bulk import options. Smart column detection reduces friction for users migrating from brokerages.

**Implementation Notes:** Enhances existing portfolio management with improved import flow, better validation, and position tracking support (shares, avg cost).

---

### Epic 2: Automated Conviction Intelligence

Users receive data-driven conviction scores (0-100) with detailed factor breakdowns, posture recommendations (Buy/Hold/Sell), confidence levels, and explanations for every score.

**FRs covered:** FR8, FR9, FR10, FR11, FR12, FR13, FR14, FR25, FR26, FR27, FR28, FR29, FR30, FR31

**User Value:** Automated, explainable conviction analysis powered by real-time market data. Users understand not just "what" the score is, but "why" it changed.

**Implementation Notes:**

- Integrates Finnhub API via Supabase Edge Function for security
- Implements server-side caching (15-min TTL) for performance
- Enhances existing conviction engine with 4-factor automation (Quality, Earnings, Analyst, Momentum)
- Provides Yahoo Finance links for external research

---

### Epic 3: Risk Monitoring & Alerts

Users receive automated risk warnings for concentration (>15%, >25%), losses (>8%, >15%), and significant gains (>25%) to support informed decision-making.

**FRs covered:** FR15, FR16, FR17, FR18

**User Value:** Proactive risk awareness without manual tracking. Users are alerted to portfolio imbalances and significant price movements.

**Implementation Notes:** Builds on portfolio data from Epic 1 and conviction scores from Epic 2. Risk calculations run client-side for instant feedback.

---

### Epic 4: Curated Stock Discovery

Users discover high-quality stock ideas through curated "Quiet Compounders" and "Gold Mines" suggestions with one-click portfolio addition.

**FRs covered:** FR19, FR20, FR21, FR22, FR23, FR24

**User Value:** Reduces research burden by surfacing pre-vetted ideas aligned with user's investment philosophy. Dismissible suggestions keep feed fresh.

**Implementation Notes:** Standalone discovery engine that integrates with portfolio management from Epic 1. Initial curation is manual; V2 can add AI-powered discovery.

---

### Epic 5: Cloud Sync & Multi-Device Access

Users can access their portfolio from any device via optional email/password authentication with seamless guest-to-auth migration.

**FRs covered:** FR32, FR33, FR34, FR35, FR36, FR37, FR38, FR39, FR43, FR44, FR45, FR46, FR47, FR48

**User Value:** Frictionless onboarding with guest mode, plus optional cloud sync for users who want multi-device access. No forced signup barrier.

**Implementation Notes:**

- Implements Supabase Auth (email/password)
- Hybrid storage strategy (localStorage for guests, PostgreSQL for auth users)
- Guest portfolio migration on signup preserves user work
- Row Level Security ensures data isolation
- UI indicators show current mode (guest banner vs account menu)

---

### Epic 6: Production Deployment & Infrastructure

Users can access Portfolio Assistant via public URL with enterprise-grade security, performance, and reliability.

**FRs covered:** FR40, FR41, FR42, NFR1-NFR28, Infrastructure Requirements

**User Value:** Fast, secure, reliable application accessible from anywhere. Professional deployment with monitoring and error handling.

**Implementation Notes:**

- Vercel frontend deployment with automatic builds
- Supabase backend setup (PostgreSQL + Auth + Edge Functions)
- Environment configuration (.env for API keys)
- Edge Function deployment (`fetch-stock-data`)
- Database migrations (schema + RLS policies + indexes)
- CORS configuration, security headers
- Error handling and graceful degradation
- Performance optimizations (caching, batching, lazy loading)

---

## Epic 1: Portfolio Management Foundation

Users can build and maintain their investment portfolio with ticker entry, CSV/Excel import with smart column detection, and portfolio-wide operations.

### Story 1.1: Manual Ticker Entry

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

### Story 1.2: Stock Display & Removal

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

### Story 1.3: Portfolio Bulk Operations

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

### Story 1.4: CSV/Excel Import with Smart Detection

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

### Story 1.5: Manual Column Mapping

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

## Epic 2: Automated Conviction Intelligence

Users receive data-driven conviction scores (0-100) with detailed factor breakdowns, posture recommendations (Buy/Hold/Sell), confidence levels, and explanations for every score.

### Story 2.1: Supabase Edge Function for Secure Stock Data Fetching

As a system administrator,
I want a secure server-side proxy for Finnhub API calls with caching,
So that API keys are never exposed in the client and users benefit from shared caching.

**Acceptance Criteria:**

**Given** Supabase project is set up
**When** I deploy the Edge Function named `fetch-stock-data`
**Then** the function is accessible via HTTPS endpoint
**And** the Finnhub API key is stored as an Edge Function secret (not in code)
**And** CORS headers allow requests from the frontend domain

**Given** a client makes a request to the Edge Function
**When** the request includes parameters: `ticker`, `endpoint` (quote|metrics|recommendations|earnings)
**Then** the function checks the `stock_cache` table for cached data
**And** if cache hit AND data < 15 minutes old: return cached data immediately
**And** if cache miss OR data > 15 minutes old: fetch from Finnhub, update cache, return data

**Given** the Edge Function receives a request for endpoint="quote"
**When** processing the request for ticker "AAPL"
**Then** it calls Finnhub API: `/quote?symbol=AAPL`
**And** returns JSON: `{ price, change, percentChange, high, low, open, previousClose }`

**Given** the Edge Function receives a request for endpoint="metrics"
**When** processing the request for ticker "AAPL"
**Then** it calls Finnhub API: `/stock/metric?symbol=AAPL&metric=all`
**And** returns JSON: `{ pe, epsGrowth, profitMargin, operatingMargin, roe, beta, week52High, week52Low }`

**Given** the Edge Function receives a request for endpoint="recommendations"
**When** processing the request for ticker "AAPL"
**Then** it calls Finnhub API: `/stock/recommendation?symbol=AAPL`
**And** returns JSON: `{ strongBuy, buy, hold, sell, strongSell, period }`

**Given** the Edge Function receives a request for endpoint="earnings"
**When** processing the request for ticker "AAPL"
**Then** it calls Finnhub API: `/stock/earnings?symbol=AAPL`
**And** returns JSON array: `[{ period, actual, estimate, surprise }]` for last 8 quarters

**Given** Finnhub API returns an error (rate limit, invalid ticker, etc.)
**When** the error is received
**Then** the function returns cached data if available (even if stale)
**And** includes a flag: `{ cached: true, stale: true, error: "Rate limit exceeded" }`
**And** if no cache available: returns error with user-friendly message

**Given** the `stock_cache` table does not exist
**When** the Edge Function is first deployed
**Then** the database migration creates the table with schema:

- `ticker` (text, primary key)
- `endpoint` (text, part of composite key)
- `data` (jsonb)
- `cached_at` (timestamp)
  **And** index on `(ticker, endpoint)` for fast lookups

---

### Story 2.2: Real-time Stock Quote Display

As an investor,
I want to see current stock price and daily performance in the stock detail panel,
So that I can understand the stock's current market position.

**Acceptance Criteria:**

**Given** I click on a stock in my portfolio
**When** the stock detail slide-over opens
**Then** I see a "Quote" section at the top showing:

- Current price (large, prominent font)
- Daily change in dollars and percentage (green if positive, red if negative)
- Today's high and low
- Previous close
  **And** I see a Yahoo Finance link icon (🔗) next to the ticker that opens Yahoo Finance in a new tab

**Given** the quote data is being fetched
**When** the API call is in progress
**Then** I see loading skeleton placeholders for price data
**And** the rest of the panel remains functional

**Given** the quote API call succeeds
**When** data is returned from the Edge Function
**Then** the quote section populates with real data
**And** positive change is shown in green with ↑ icon
**And** negative change is shown in red with ↓ icon
**And** zero change is shown in gray with → icon

**Given** the quote API call fails
**When** the Edge Function returns an error
**Then** I see cached data if available with a banner: "Showing cached data (15 min old)"
**And** if no cache: I see an error message: "Unable to fetch current quote. Please try again."
**And** a "Retry" button appears to manually retry the fetch

**Given** I am viewing multiple stock details in succession
**When** I navigate from one stock to another
**Then** each stock's quote data is fetched independently
**And** cached data is used when available to improve performance

---

### Story 2.3: Company Fundamentals Display

As an investor,
I want to see key financial metrics for a company,
So that I can assess its fundamental health and quality.

**Acceptance Criteria:**

**Given** I am viewing the stock detail slide-over
**When** the fundamentals data loads
**Then** I see a "Key Metrics" section showing:

- P/E Ratio (with label "P/E")
- Profit Margin (percentage)
- Operating Margin (percentage)
- Return on Equity / ROE (percentage)
- EPS (Earnings Per Share)
  **And** each metric is clearly labeled with its name

**Given** a metric value is not available from Finnhub
**When** the API returns null or undefined for that metric
**Then** the metric displays "N/A" instead of a value
**And** the section remains visually consistent

**Given** fundamentals data is loading
**When** the API call is in progress
**Then** I see loading skeleton placeholders for each metric
**And** the placeholders match the layout of the real data

**Given** all fundamentals data is unavailable
**When** Finnhub returns no metrics for the ticker
**Then** I see a message: "Fundamental data not available for this stock"
**And** the section is visually minimized but still present

**Given** I am viewing fundamentals for a high-quality company
**When** the data loads
**Then** metrics like high ROE (>20%), high profit margins (>20%) are visible
**And** these values are used by the Quality factor in the conviction engine (Story 2.6)

---

### Story 2.4: Analyst Recommendations Display

As an investor,
I want to see Wall Street analyst consensus for a stock,
So that I can incorporate professional opinions into my decision-making.

**Acceptance Criteria:**

**Given** I am viewing the stock detail slide-over
**When** analyst recommendations data loads
**Then** I see a "Wall Street Consensus" section showing:

- Count of Strong Buy recommendations
- Count of Buy recommendations
- Count of Hold recommendations
- Count of Sell recommendations
- Count of Strong Sell recommendations
  **And** the section displays as a horizontal bar or pill layout for scannability

**Given** analyst recommendations are heavily positive
**When** the data shows majority Strong Buy + Buy ratings
**Then** the visual representation emphasizes the positive sentiment (green tint or highlight)
**And** a summary badge appears: "Consensus: Strong Buy" or "Consensus: Buy"

**Given** analyst recommendations are mixed or neutral
**When** the data shows majority Hold ratings
**Then** the summary badge appears: "Consensus: Hold"
**And** the visual representation uses neutral colors (amber/yellow)

**Given** analyst recommendations are negative
**When** the data shows majority Sell ratings
**Then** the summary badge appears: "Consensus: Sell"
**And** the visual representation uses warning colors (red tint)

**Given** no analyst recommendations are available
**When** Finnhub returns empty or null data
**Then** I see a message: "No analyst coverage available for this stock"
**And** the conviction engine's Analyst factor defaults to 50/100 (neutral)

**Given** analyst data is fetched successfully
**When** the recommendations are displayed
**Then** the data is passed to the conviction engine for Analyst score calculation (Story 2.6)
**And** the Analyst factor score (0-100) is derived from this consensus

---

### Story 2.5: Earnings History Display

As an investor,
I want to see quarterly earnings results vs estimates,
So that I can assess the company's execution consistency and momentum.

**Acceptance Criteria:**

**Given** I am viewing the stock detail slide-over
**When** earnings history data loads
**Then** I see an "Earnings History" section showing the last 4-8 quarters
**And** each quarter displays:

- Quarter label (e.g., "Q4 2025")
- Actual EPS
- Estimated EPS
- Beat/Miss/Inline indicator (✅ Beat, ➖ Inline, ❌ Miss)

**Given** a quarter shows actual EPS > estimated EPS
**When** the data is rendered
**Then** the row has a green "✅ Beat" indicator
**And** the earnings surprise is visually emphasized

**Given** a quarter shows actual EPS < estimated EPS
**When** the data is rendered
**Then** the row has a red "❌ Miss" indicator
**And** the negative surprise is visually de-emphasized but clear

**Given** a quarter shows actual EPS = estimated EPS (within 1%)
**When** the data is rendered
**Then** the row has a neutral "➖ Inline" indicator
**And** neutral styling is applied

**Given** earnings history shows a consistent beat pattern (3+ quarters)
**When** the data is displayed
**Then** this pattern is visible at a glance through repeated green indicators
**And** the conviction engine's Earnings factor scores this positively (Story 2.6)

**Given** earnings history shows a recent miss after beats
**When** the data is displayed
**Then** the recent miss is prominently visible
**And** the conviction engine's Earnings factor penalizes this in scoring (Story 2.6)

**Given** no earnings history is available
**When** Finnhub returns empty data
**Then** I see a message: "No earnings history available for this stock"
**And** the Earnings factor defaults to 50/100 (neutral)

---

### Story 2.6: Enhanced 4-Factor Conviction Engine

As an investor,
I want conviction scores to be automatically calculated from live market data using 4 factors,
So that I receive objective, data-driven investment signals without manual input.

**Acceptance Criteria:**

**Given** stock data has been fetched from Finnhub (Stories 2.2-2.5)
**When** the conviction engine processes the data
**Then** it calculates 4 factor scores (0-100 each):

1. **Quality Score** (from fundamentals - Story 2.3)
2. **Earnings Score** (from earnings history - Story 2.5)
3. **Analyst Score** (from recommendations - Story 2.4)
4. **Momentum Score** (from quote data - Story 2.2)
   **And** each factor is weighted equally (25% each)
   **And** the overall conviction score = average of 4 factors

**Given** Quality factor is being calculated
**When** fundamentals data is available
**Then** the score is based on:

- P/E ratio (lower = better, penalty if > 30)
- Profit margin (higher = better, bonus if > 20%)
- Operating margin (higher = better, bonus if > 15%)
- ROE (higher = better, bonus if > 20%)
- EPS (positive = baseline 60, negative = penalty)
  **And** Quality score ranges 0-100 with 50 as neutral

**Given** Earnings factor is being calculated
**When** earnings history is available
**Then** the score is based on:

- Beat/Miss pattern (consecutive beats = bonus)
- EPS growth rate quarter-over-quarter
- Surprise magnitude (bigger beat = higher score)
  **And** Earnings score ranges 0-100 with 50 as neutral

**Given** Analyst factor is being calculated
**When** recommendations data is available
**Then** the score is based on consensus:

- Strong Buy majority → 85-100
- Buy majority → 65-84
- Hold majority → 35-64
- Sell majority → 15-34
- Strong Sell majority → 0-14
  **And** weighted by number of analysts (more coverage = higher confidence)

**Given** Momentum factor is being calculated
**When** quote data is available
**Then** the score is based on:

- Position in 52-week range (closer to high = better)
- Daily change (positive = bonus)
- Beta (lower volatility = small bonus)
  **And** Momentum score ranges 0-100 with 50 as neutral

**Given** all 4 factor scores are calculated
**When** determining overall conviction score
**Then** conviction score = (Quality + Earnings + Analyst + Momentum) / 4
**And** the score is rounded to nearest integer

**Given** conviction score >= 60
**When** determining posture
**Then** posture = "Buy"
**And** posture badge is green

**Given** conviction score between 35-59
**When** determining posture
**Then** posture = "Hold"
**And** posture badge is amber/yellow

**Given** conviction score < 35
**When** determining posture
**Then** posture = "Sell"
**And** posture badge is red

**Given** factor scores have low variance (all within 15 points)
**When** determining confidence
**Then** confidence = "High"
**And** badge has solid ring highlight

**Given** factor scores have medium variance (within 15-30 points)
**When** determining confidence
**Then** confidence = "Medium"
**And** badge has standard solid border

**Given** factor scores have high variance (> 30 points spread)
**When** determining confidence
**Then** confidence = "Low"
**And** badge has dashed border (indicating uncertainty)

---

### Story 2.7: Score Breakdown UI with Explanatory Tooltips

As an investor,
I want to see how each factor contributes to the overall conviction score,
So that I understand the reasoning behind the score and can identify strengths/weaknesses.

**Acceptance Criteria:**

**Given** I am viewing the stock detail slide-over
**When** conviction score data is available
**Then** I see a "Score Breakdown" section showing:

- Overall conviction score (large, prominent)
- Posture badge (Buy/Hold/Sell with confidence)
- 4 horizontal bars for each factor (Quality, Earnings, Analyst, Momentum)
  **And** each bar shows: Factor name, visual progress bar, numeric score (0-100)

**Given** a factor score is >= 60
**When** the factor bar is rendered
**Then** the bar is colored green
**And** the bar fills proportionally (60/100 = 60% filled)

**Given** a factor score is between 35-59
**When** the factor bar is rendered
**Then** the bar is colored amber/yellow
**And** the bar fills proportionally

**Given** a factor score is < 35
**When** the factor bar is rendered
**Then** the bar is colored red
**And** the bar fills proportionally

**Given** I hover over the info icon (ⓘ) next to "Quality"
**When** the tooltip appears
**Then** it displays: "Based on P/E ratio, profit margins, operating margin, ROE, and EPS"
**And** the tooltip remains visible while hovering
**And** it disappears when I move my cursor away

**Given** I hover over the info icon (ⓘ) next to "Earnings"
**When** the tooltip appears
**Then** it displays: "Based on quarterly EPS trend, beat/miss history, and growth rate"

**Given** I hover over the info icon (ⓘ) next to "Analyst"
**When** the tooltip appears
**Then** it displays: "Wall Street consensus converted to 0-100 score. More analysts = higher confidence."

**Given** I hover over the info icon (ⓘ) next to "Momentum"
**When** the tooltip appears
**Then** it displays: "Based on 52-week range position, daily change, and volatility (beta)"

**Given** I am viewing the score breakdown on a tablet
**When** I tap the info icon (ⓘ) instead of hovering
**Then** the tooltip appears and remains visible
**And** tapping outside the tooltip dismisses it

**Given** the score breakdown is displayed
**When** I scroll down in the slide-over panel
**Then** I see a footer disclaimer: "Score is 100% data-driven from Finnhub. Conviction reflects cumulative signals, not a price prediction."

---

### Story 2.8: Score Delta Tracking & Manual Refresh

As an investor,
I want to see how conviction scores have changed since my last view and manually refresh all data,
So that I can track conviction trends and get the latest information on demand.

**Acceptance Criteria:**

**Given** a stock has a previous conviction score stored
**When** new conviction score is calculated
**Then** the system calculates delta = (new score - previous score)
**And** stores the new score as the "current" score
**And** the delta is displayed next to the conviction score

**Given** conviction score has increased
**When** displaying the delta
**Then** I see an upward arrow (↑) in green
**And** the delta value (e.g., "+5") in green text

**Given** conviction score has decreased
**When** displaying the delta
**Then** I see a downward arrow (↓) in red
**And** the delta value (e.g., "-12") in red text

**Given** conviction score is unchanged
**When** displaying the delta
**Then** I see a horizontal arrow (→) in gray
**And** the delta value "0" in gray text

**Given** this is the first time a stock is scored
**When** displaying the delta
**Then** no delta is shown (or shows "New" badge)
**And** the current score becomes the baseline for future deltas

**Given** I am viewing my portfolio
**When** I click the "Refresh All" button in the header
**Then** all stocks in my portfolio trigger data fetches
**And** I see loading indicators on each stock card
**And** scores update sequentially as data returns
**And** delta calculations update based on previous scores

**Given** I click "Refresh All" and some API calls fail
**When** errors occur for specific stocks
**Then** failed stocks show an error indicator
**And** successful stocks update normally
**And** a toast notification summarizes: "Refreshed {N} stocks. {M} failed - using cached data."

**Given** I manually refresh and data is cached < 5 minutes old
**When** the refresh is triggered
**Then** cached data is used immediately (no API call)
**And** a subtle indicator shows "Data age: 2 min" below the score
**And** this provides instant feedback while respecting rate limits

**Given** I add a new stock via Story 1.1 or 1.4
**When** the stock is added to portfolio
**Then** the system automatically triggers a data fetch for that stock (auto-refresh)
**And** I don't need to manually click "Refresh All"
**And** the score populates within 3-5 seconds

---

## Epic 3: Risk Monitoring & Alerts

Users receive automated risk warnings for concentration (>15%, >25%), losses (>8%, >15%), and significant gains (>25%) to support informed decision-making.

### Story 3.1: Portfolio Weight Calculation & Concentration Alerts

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

### Story 3.2: Loss & Gain Alert Detection

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

### Story 3.3: Risk Warning Display on Stock Cards

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

## Epic 4: Curated Stock Discovery

Users discover high-quality stock ideas through curated "Quiet Compounders" and "Gold Mines" suggestions with one-click portfolio addition.

### Story 4.1: Curated Stock Suggestions Data Structure

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

### Story 4.2: Suggested Finds Tab UI

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

### Story 4.3: Dismiss & Replace Suggestions

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

### Story 4.4: One-Click Add to Portfolio

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

## Epic 5: Cloud Sync & Multi-Device Access

Users can access their portfolio from any device via optional email/password authentication with seamless guest-to-auth migration.

### Story 5.1: Supabase Project Setup & Database Schema

As a system administrator,
I want a Supabase project with database schema and security policies,
So that authenticated users can securely store and sync their portfolio data in the cloud.

**Acceptance Criteria:**

**Given** Supabase project does not exist
**When** setting up the backend infrastructure
**Then** a new Supabase project is created with a descriptive name (e.g., "portfolio-assistant-prod")
**And** the project is in a region close to primary users (e.g., US East)
**And** project URL and anon key are noted for frontend configuration

**Given** database schema needs to be created
**When** running initial migrations
**Then** the following tables are created:

**Table: `portfolios`**

- `id` (uuid, primary key, default: uuid_generate_v4())
- `user_id` (uuid, references auth.users, not null)
- `ticker` (text, not null)
- `shares` (numeric, nullable)
- `avg_cost` (numeric, nullable)
- `company_name` (text, nullable)
- `added_at` (timestamp, default: now())
- `updated_at` (timestamp, default: now())
- Composite unique constraint: `(user_id, ticker)`
- Index on `user_id` for fast queries

**Table: `stock_cache`**

- `ticker` (text, not null)
- `endpoint` (text, not null, enum: 'quote', 'metrics', 'recommendations', 'earnings')
- `data` (jsonb, not null)
- `cached_at` (timestamp, default: now())
- Primary key: `(ticker, endpoint)`
- Index on `cached_at` for TTL checks

**Table: `user_dismissals`**

- `id` (uuid, primary key, default: uuid_generate_v4())
- `user_id` (uuid, references auth.users, not null)
- `ticker` (text, not null)
- `archetype` (text, not null)
- `dismissed_at` (timestamp, default: now())
- Composite unique constraint: `(user_id, ticker, archetype)`
- Index on `user_id`

**Given** Row Level Security (RLS) needs to be enforced
**When** security policies are created
**Then** RLS is enabled on `portfolios` table with policies:

- SELECT: `user_id = auth.uid()` (users see only their own data)
- INSERT: `user_id = auth.uid()` (users can only insert their own data)
- UPDATE: `user_id = auth.uid()` (users can only update their own data)
- DELETE: `user_id = auth.uid()` (users can only delete their own data)

**And** RLS is enabled on `user_dismissals` table with similar policies:

- SELECT: `user_id = auth.uid()`
- INSERT: `user_id = auth.uid()`
- DELETE: `user_id = auth.uid()`

**And** `stock_cache` table has read-only RLS:

- SELECT: `true` (all authenticated users can read cache)
- INSERT/UPDATE/DELETE: restricted to service role only (Edge Function)

**Given** Supabase Auth is configured
**When** setting up authentication
**Then** email/password provider is enabled
**And** email confirmations are disabled for MVP (instant login after signup)
**And** password requirements: minimum 8 characters
**And** magic links and OAuth providers are disabled

**Given** database is deployed
**When** testing connectivity
**Then** frontend can connect using Supabase client with anon key
**And** RLS policies correctly restrict access to user's own data
**And** unauthenticated requests are rejected for protected tables

---

### Story 5.2: Storage Adapter Pattern

As a developer,
I want a storage adapter interface that abstracts localStorage and Supabase implementations,
So that the app can seamlessly switch between guest and authenticated storage without changing business logic.

**Acceptance Criteria:**

**Given** the app needs to support hybrid storage
**When** the storage layer is designed
**Then** a `StorageAdapter` interface is defined with methods:

- `getPortfolio(): Promise<Stock[]>`
- `savePortfolio(stocks: Stock[]): Promise<void>`
- `addStock(stock: Stock): Promise<void>`
- `removeStock(ticker: string): Promise<void>`
- `clearPortfolio(): Promise<void>`
- `getDismissals(): Promise<Dismissal[]>`
- `saveDismissal(ticker: string, archetype: string): Promise<void>`

**Given** guest mode storage is needed
**When** implementing `LocalStorageAdapter`
**Then** it implements all `StorageAdapter` methods using browser localStorage
**And** portfolio data is stored in key: `portfolio-assistant-data`
**And** dismissals are stored in key: `portfolio-assistant-dismissals`
**And** all operations are synchronous but wrapped in promises for interface consistency
**And** localStorage is never accessed directly outside this adapter

**Given** authenticated mode storage is needed
**When** implementing `SupabaseStorageAdapter`
**Then** it implements all `StorageAdapter` methods using Supabase client
**And** portfolio methods query/mutate the `portfolios` table
**And** dismissal methods query/mutate the `user_dismissals` table
**And** all operations handle Supabase errors gracefully
**And** RLS policies are enforced automatically

**Given** the app is initialized
**When** determining which adapter to use
**Then** a `StorageManager` checks if user is authenticated (via Supabase Auth)
**And** if authenticated: returns `SupabaseStorageAdapter` instance
**And** if guest: returns `LocalStorageAdapter` instance
**And** the active adapter is cached and reused throughout the session

**Given** business logic needs to access storage
**When** components fetch or update portfolio data
**Then** they call `StorageManager.getAdapter()` to get the current adapter
**And** they use adapter methods without knowing the underlying implementation
**And** switching from guest to auth requires only changing the adapter instance

**Given** errors occur during Supabase operations
**When** a network failure or database error happens
**Then** the adapter returns a rejected promise with a user-friendly error message
**And** the UI handles the error gracefully (shows toast, allows retry)
**And** guest users never see Supabase-related errors

**Given** the adapter pattern is implemented
**When** running tests
**Then** a `MockStorageAdapter` can be created for unit testing
**And** business logic is decoupled from storage implementation
**And** future storage backends (e.g., Firebase) can be added by implementing the interface

---

### Story 5.3: Guest Mode Experience

As a new user,
I want to use Portfolio Assistant without creating an account,
So that I can evaluate the product before committing to signup.

**Acceptance Criteria:**

**Given** I visit Portfolio Assistant for the first time
**When** the app loads
**Then** I am in guest mode by default (no login required)
**And** I see a guest mode banner at the top: "You're using Portfolio Assistant as a guest. Your data is saved in this browser only."
**And** the banner includes a "Sign Up" button styled as a primary action

**Given** I am in guest mode
**When** I use portfolio features (add stocks, view scores, etc.)
**Then** all functionality works exactly as it would for authenticated users
**And** data is saved to localStorage automatically
**And** there are no feature limitations or nag screens

**Given** I am in guest mode and refresh the browser
**When** the page reloads
**Then** my portfolio data persists from localStorage
**And** I remain in guest mode
**And** the guest banner is still visible

**Given** I am in guest mode and close the browser
**When** I return to the site days later (same browser/device)
**Then** my portfolio data is still available
**And** localStorage persists indefinitely (until browser cache is cleared)

**Given** I am in guest mode and clear my browser data
**When** localStorage is cleared
**Then** my portfolio is lost (expected behavior)
**And** the app gracefully handles empty localStorage
**And** I see the empty portfolio state: "Your portfolio is empty. Add stocks to get started."

**Given** I am in guest mode on Device A
**When** I open Portfolio Assistant on Device B
**Then** I see an empty portfolio on Device B (localStorage is device-specific)
**And** Device A's data is unaffected
**And** the guest banner appears on both devices

**Given** I am in guest mode and click "Sign Up" in the banner
**When** the signup button is clicked
**Then** the signup modal opens (Story 5.4)
**And** I am prompted to create an account
**And** after signup, my guest data is migrated to the cloud (Story 5.5)

---

### Story 5.4: User Registration & Login

As a user,
I want to create an account with email and password,
So that I can sync my portfolio across devices and access it from anywhere.

**Acceptance Criteria:**

**Given** I am in guest mode
**When** I click "Sign Up" in the guest banner or header
**Then** a signup modal opens with fields:

- Email (text input, required)
- Password (password input, required, min 8 characters)
- Confirm Password (password input, required, must match)
- "Create Account" button
- Link to login: "Already have an account? Log in"
  **And** the modal has a close (X) button

**Given** I enter valid email and matching passwords
**When** I click "Create Account"
**Then** Supabase Auth creates a new user account
**And** I am automatically logged in
**And** the modal closes
**And** my guest portfolio is migrated to the cloud (Story 5.5)
**And** I see a success toast: "Account created! Your portfolio has been synced to the cloud."
**And** the guest banner is replaced with an account menu (Story 5.7)

**Given** I enter an email that already exists
**When** I click "Create Account"
**Then** I see an error message: "This email is already registered. Please log in instead."
**And** the modal remains open
**And** no account is created

**Given** I enter passwords that don't match
**When** I click "Create Account"
**Then** I see an error message: "Passwords do not match"
**And** the "Confirm Password" field is highlighted in red
**And** the modal remains open

**Given** I enter a password < 8 characters
**When** I click "Create Account"
**Then** I see an error message: "Password must be at least 8 characters"
**And** the form does not submit

**Given** I am on the signup modal
**When** I click "Already have an account? Log in"
**Then** the signup modal closes
**And** the login modal opens immediately (seamless transition)

**Given** I want to log in with an existing account
**When** I open the login modal
**Then** I see fields:

- Email (text input, required)
- Password (password input, required)
- "Log In" button
- Link to signup: "Don't have an account? Sign up"
  **And** the modal has a close (X) button

**Given** I enter valid credentials in the login modal
**When** I click "Log In"
**Then** Supabase Auth authenticates me
**And** the modal closes
**And** my cloud portfolio is loaded from Supabase (Story 5.6)
**And** I see a success toast: "Welcome back!"
**And** the guest banner is replaced with an account menu (Story 5.7)

**Given** I enter invalid credentials (wrong password or email not found)
**When** I click "Log In"
**Then** I see an error message: "Invalid email or password"
**And** the modal remains open
**And** I can retry

**Given** I am on the login modal
**When** I click "Don't have an account? Sign up"
**Then** the login modal closes
**And** the signup modal opens immediately

**Given** network errors occur during signup/login
**When** Supabase API calls fail
**Then** I see an error message: "Connection error. Please try again."
**And** the modal remains open for retry
**And** my data remains safe (no partial state)

---

### Story 5.5: Guest-to-Auth Migration

As a guest user who signs up,
I want my existing portfolio to be automatically transferred to my new account,
So that I don't lose any work I've done before creating an account.

**Acceptance Criteria:**

**Given** I have stocks in my portfolio as a guest
**When** I complete signup (Story 5.4)
**Then** the system detects non-empty localStorage portfolio
**And** triggers automatic migration to Supabase

**Given** migration is triggered
**When** processing guest data
**Then** the system reads all stocks from localStorage (via `LocalStorageAdapter`)
**And** inserts each stock into the `portfolios` table with `user_id` = my new auth user ID
**And** handles duplicates gracefully (if ticker already exists in cloud, skip)

**Given** I have 10 stocks in my guest portfolio
**When** migration runs
**Then** all 10 stocks are inserted into Supabase
**And** the migration completes within 2-3 seconds
**And** I see a loading indicator: "Syncing your portfolio to the cloud..."

**Given** migration completes successfully
**When** the process finishes
**Then** localStorage portfolio is optionally cleared (or marked as migrated)
**And** the app switches to `SupabaseStorageAdapter`
**And** I see all my stocks in the Portfolio tab
**And** a success toast appears: "Your portfolio has been synced! Access it from any device."

**Given** migration encounters errors (network failure, rate limit)
**When** the error occurs
**Then** localStorage data is NOT cleared (safety first)
**And** I see an error message: "Failed to sync portfolio to cloud. Your data is safe in this browser. Try logging in again to retry."
**And** my guest data remains intact for manual retry

**Given** I have dismissed suggestions as a guest
**When** migration runs
**Then** dismissed suggestions are also migrated to `user_dismissals` table
**And** dismissed stocks remain hidden after migration
**And** dismissal state is consistent across devices after migration

**Given** I sign up with a completely empty portfolio
**When** migration runs
**Then** no data is inserted into Supabase (no-op)
**And** the migration completes instantly
**And** I start with an empty cloud portfolio

**Given** I log in on a second device after migrating
**When** the app loads
**Then** I see my migrated portfolio on the second device
**And** all stocks, scores, and dismissals are present
**And** changes on Device A sync to Device B (and vice versa)

**Given** I manually log out and log back in on the same device
**When** I re-authenticate
**Then** the system does NOT re-migrate localStorage data
**And** cloud data takes precedence (no duplicates)
**And** localStorage may still contain old guest data but is ignored

---

### Story 5.6: Cloud Portfolio Sync

As an authenticated user,
I want my portfolio changes to automatically sync to the cloud,
So that I can access my portfolio from any device and never lose my data.

**Acceptance Criteria:**

**Given** I am logged in as an authenticated user
**When** I add a stock to my portfolio
**Then** the stock is immediately inserted into the Supabase `portfolios` table
**And** the INSERT happens via `SupabaseStorageAdapter.addStock()`
**And** RLS policy ensures the stock is linked to my `user_id`

**Given** I am logged in as an authenticated user
**When** I remove a stock from my portfolio
**Then** the stock is immediately deleted from the Supabase `portfolios` table
**And** the DELETE happens via `SupabaseStorageAdapter.removeStock()`
**And** the stock is removed only for my `user_id` (other users' data unaffected)

**Given** I am logged in as an authenticated user
**When** I clear my entire portfolio
**Then** all my stocks are deleted from Supabase (via DELETE WHERE user_id = auth.uid())
**And** other users' portfolios remain unaffected
**And** the operation completes within 1 second

**Given** I am logged in on Device A
**When** I add a stock on Device A
**Then** the stock is saved to Supabase
**And** when I open Portfolio Assistant on Device B
**And** I log in on Device B
**Then** I see the stock added from Device A

**Given** I am logged in on both Device A and Device B simultaneously
**When** I add a stock on Device A
**Then** Device B does NOT automatically refresh (real-time sync is V2)
**And** Device B sees the new stock after manually refreshing the page
**And** this behavior is acceptable for MVP with 10 users

**Given** I lose network connectivity while authenticated
**When** I attempt to add or remove stocks
**Then** the operation fails with an error: "Connection error. Changes not saved. Please try again when online."
**And** the UI shows a warning banner: "You're offline. Changes won't sync until you're back online."
**And** localStorage is NOT used as a fallback (cloud users expect cloud consistency)

**Given** Supabase connection fails temporarily
**When** I perform portfolio operations
**Then** errors are displayed clearly: "Failed to sync. Please try again."
**And** a "Retry" button allows immediate retry
**And** I am NOT automatically logged out (auth session persists)

**Given** I am logged in and viewing my portfolio
**When** the page loads
**Then** the app fetches my portfolio from Supabase using `SELECT * FROM portfolios WHERE user_id = auth.uid()`
**And** the query completes within 1-2 seconds
**And** stocks are displayed in the Portfolio tab
**And** localStorage is NOT read (cloud data is source of truth)

**Given** I am logged in and import a CSV file
**When** the import completes (Story 1.4)
**Then** all imported stocks are inserted into Supabase in a batch operation
**And** the batch insert completes within 2-3 seconds for 50 stocks
**And** duplicate tickers are handled by ON CONFLICT DO NOTHING or UPDATE

**Given** I dismiss a suggestion while logged in
**When** the dismissal occurs
**Then** the dismissal is saved to `user_dismissals` table with my `user_id`
**And** dismissed suggestions remain hidden across all my devices
**And** dismissals sync just like portfolio data

---

### Story 5.7: Account Management UI

As a user,
I want clear visual indicators of my auth status and easy access to login/logout,
So that I always know if my data is syncing to the cloud and can manage my account.

**Acceptance Criteria:**

**Given** I am in guest mode
**When** viewing the app header
**Then** I see a guest mode banner at the top of the page
**And** the banner displays: "You're using Portfolio Assistant as a guest. Your data is saved in this browser only."
**And** the banner includes a "Sign Up" button (primary style, green or blue)
**And** the banner is visually distinct but not intrusive (e.g., light yellow background, info icon)

**Given** I am in guest mode
**When** viewing the app header navigation
**Then** I see a "Log In" link in the top-right corner
**And** clicking it opens the login modal (Story 5.4)

**Given** I am logged in as an authenticated user
**When** viewing the app header
**Then** the guest banner is NOT visible
**And** I see an account menu in the top-right corner
**And** the menu shows my email address or first part of email (e.g., "user@example.com" or "user")

**Given** I am logged in
**When** I click on the account menu
**Then** a dropdown appears with options:

- Email address (non-clickable, displayed at top for context)
- "Log Out" button (clickable)
  **And** the dropdown is styled consistently with the app theme

**Given** I am logged in and click "Log Out"
**When** the logout action is triggered
**Then** Supabase Auth signs me out
**And** the app switches to guest mode
**And** the guest banner reappears
**And** my localStorage is cleared (or marked as inactive)
**And** I see an empty portfolio (logged-out state)
**And** a toast notification appears: "You've been logged out. Your cloud data is safe."

**Given** I log out and then log back in
**When** I authenticate again
**Then** my cloud portfolio is loaded from Supabase
**And** I see all my stocks exactly as I left them
**And** the account menu reappears with my email

**Given** my auth session expires (after 7 days or 30 days depending on "Remember Me")
**When** I return to the app
**Then** I am automatically logged out
**And** I see the guest mode experience
**And** a toast notification: "Session expired. Please log in again."

**Given** I am logged in on multiple tabs
**When** I log out in Tab A
**Then** Tab B detects the session change (via Supabase Auth listener)
**And** Tab B also shows the logged-out state
**And** this provides consistent experience across tabs

**Given** I am in guest mode and have stocks in localStorage
**When** I log in (not signup) with an existing account
**Then** the app asks: "You have {N} stocks in your browser. Would you like to merge them with your cloud portfolio?"
**And** options are: "Merge", "Discard Local Data", "Cancel"
**And** selecting "Merge" triggers migration to cloud (Story 5.5)
**And** selecting "Discard" clears localStorage and loads cloud data only

**Given** I am viewing auth-related modals (login/signup)
**When** I press the Escape key
**Then** the modal closes
**And** I return to the previous view (guest or authenticated)

**Given** I am on a tablet or mobile device
**When** viewing the auth UI
**Then** modals are responsive and readable
**And** forms are easy to complete on touch devices
**And** the guest banner adapts to smaller screens (text may wrap or abbreviate)

---

## Epic 6: Production Deployment & Infrastructure

Users can access Portfolio Assistant via public URL with enterprise-grade security, performance, and reliability.

### Story 6.1: Environment Configuration & Secrets Management

As a system administrator,
I want secure environment configuration for all API keys and service URLs,
So that sensitive credentials are never exposed in client code or version control.

**Acceptance Criteria:**

**Given** the frontend needs to connect to Supabase
**When** setting up environment variables
**Then** a `.env` file is created with:

- `VITE_SUPABASE_URL` = Supabase project URL
- `VITE_SUPABASE_ANON_KEY` = Supabase anonymous key (safe for client)
  **And** the `.env` file is added to `.gitignore` (never committed)
  **And** a `.env.example` file is committed with placeholder values as a template

**Given** the Edge Function needs to call Finnhub API
**When** setting up Edge Function secrets
**Then** the Finnhub API key is stored as a Supabase secret named `FINNHUB_API_KEY`
**And** the secret is set via Supabase CLI: `supabase secrets set FINNHUB_API_KEY=<key>`
**And** the secret is accessible in Edge Function via `Deno.env.get('FINNHUB_API_KEY')`
**And** the key is NEVER hardcoded in the Edge Function code

**Given** the app is deployed to Vercel
**When** configuring Vercel environment variables
**Then** all `VITE_*` variables are added to Vercel project settings
**And** environment variables are marked as production-only (not exposed in preview builds if sensitive)
**And** Vercel automatically injects these variables during build

**Given** a developer clones the repository
**When** setting up their local environment
**Then** they copy `.env.example` to `.env`
**And** they populate their own Supabase project URL and anon key
**And** they can run the app locally with their own Supabase instance
**And** README includes clear instructions for environment setup

**Given** API keys need to be rotated
**When** updating credentials
**Then** Supabase secrets can be updated via CLI without code changes
**And** Vercel environment variables can be updated in dashboard
**And** changes take effect on next deployment (Edge Function) or build (frontend)

**Given** the `.env` file exists locally
**When** running git status
**Then** `.env` does NOT appear in untracked files (correctly ignored)
**And** only `.env.example` is committed to version control

---

### Story 6.2: Vercel Deployment

As a system administrator,
I want to deploy the frontend to Vercel with automatic builds,
So that users can access Portfolio Assistant via a public URL with CDN performance.

**Acceptance Criteria:**

**Given** the frontend code is ready for deployment
**When** setting up Vercel project
**Then** a new Vercel project is created and linked to the GitHub repository
**And** the project name is descriptive (e.g., "portfolio-assistant")
**And** the root directory is set to `app/` (where Vite project lives)

**Given** Vercel needs to build the Vite app
**When** configuring build settings
**Then** build command is set to: `npm run build` or `vite build`
**And** output directory is set to: `dist`
**And** install command is set to: `npm install`
**And** Node.js version is set to 18.x or 20.x (latest LTS)

**Given** environment variables are needed for production
**When** configuring Vercel
**Then** all `VITE_*` variables are added in Vercel dashboard → Environment Variables
**And** variables are set for Production, Preview, and Development environments
**And** sensitive values are marked as sensitive (masked in UI)

**Given** code is pushed to the main branch
**When** GitHub triggers a webhook
**Then** Vercel automatically builds and deploys the app
**And** the deployment completes within 2-3 minutes
**And** the new version is live at the production URL (e.g., `portfolio-assistant.vercel.app`)

**Given** code is pushed to a feature branch
**When** Vercel detects the push
**Then** a preview deployment is created with a unique URL
**And** the preview URL is commented on the GitHub PR (if applicable)
**And** preview deployments use the same environment variables as production

**Given** a deployment succeeds
**When** the build completes
**Then** I can access the app at the Vercel URL
**And** the app loads within 3 seconds on typical broadband (NFR1)
**And** all assets are served via Vercel's global CDN
**And** HTTPS is enforced automatically by Vercel

**Given** a deployment fails (build error, etc.)
**When** Vercel detects the failure
**Then** the previous successful deployment remains live (no downtime)
**And** deployment logs are available in Vercel dashboard for debugging
**And** an email notification is sent to the project owner

**Given** custom domain is desired (optional)
**When** configuring DNS
**Then** a custom domain (e.g., `portfolioassistant.com`) can be added in Vercel
**And** Vercel automatically provisions SSL certificate
**And** DNS records point to Vercel's servers
**And** this is optional for MVP (Vercel subdomain is acceptable)

**Given** the app is deployed
**When** users access the URL
**Then** they see the Portfolio Assistant homepage
**And** guest mode works immediately (no login required)
**And** authenticated mode works after signup/login
**And** all features (portfolio, scoring, suggestions) are functional

---

### Story 6.3: Performance Optimizations

As a user,
I want the app to load quickly and respond instantly to my actions,
So that I have a smooth, professional experience.

**Acceptance Criteria:**

**Given** the app is accessed on typical broadband
**When** loading the homepage
**Then** initial page load completes within 3 seconds (NFR1)
**And** Time to First Byte (TTFB) is < 500ms
**And** Largest Contentful Paint (LCP) is < 2.5 seconds
**And** First Input Delay (FID) is < 100ms

**Given** I click on a tab (Portfolio ↔ Suggested Finds)
**When** the tab switch occurs
**Then** the transition completes within 100ms (NFR3)
**And** the navigation feels instantaneous
**And** no network requests are needed for tab switching

**Given** I trigger a data refresh for 10 stocks
**When** clicking "Refresh All"
**Then** all data is fetched and displayed within 5 seconds (NFR2)
**And** stocks update progressively as data returns (not all at once)
**And** loading indicators show progress for each stock

**Given** I import a CSV file with 100 stocks
**When** processing the import
**Then** the import completes within 2 seconds (NFR4)
**And** column detection happens instantly (<500ms)
**And** the preview modal appears without delay

**Given** Finnhub API responses are cached
**When** requesting data for the same ticker within 5 minutes
**Then** cached data is returned from Supabase (NFR5)
**And** no Finnhub API call is made
**And** the response is instant (<200ms)

**Given** multiple stocks need data simultaneously
**When** refreshing the portfolio
**Then** API calls are batched where possible (NFR6)
**And** at most 5 concurrent requests are made (rate limit consideration)
**And** remaining requests queue and execute after completion

**Given** I navigate to the Portfolio tab with existing data
**When** the tab loads
**Then** cached data is displayed immediately (NFR7)
**And** fresh data is fetched in the background
**And** UI updates seamlessly when fresh data arrives (no flickering)

**Given** I am viewing the stock detail slide-over
**When** the panel opens
**Then** it appears within 50ms with animation
**And** data sections load progressively (quote first, then metrics, then earnings)
**And** I can interact with loaded sections while others are still loading

**Given** the app bundle is built for production
**When** analyzing bundle size
**Then** main JS bundle is < 500KB gzipped
**And** code splitting is used for large libraries
**And** vendor chunks are separated for better caching
**And** unused code is tree-shaken by Vite

**Given** images and icons are used in the UI
**When** rendering the page
**Then** icons are SVG-based (Lucide React) for small file size
**And** no large images are used (icon-based UI)
**And** lazy loading is applied to below-the-fold content if needed

---

### Story 6.4: Error Handling & Graceful Degradation

As a user,
I want the app to handle errors gracefully without crashing,
So that I can continue working even when things go wrong.

**Acceptance Criteria:**

**Given** the Finnhub API is unavailable or rate-limited
**When** requesting stock data
**Then** the app displays cached data with a banner: "Showing cached data. API temporarily unavailable." (NFR17, NFR20)
**And** no error crashes the UI
**And** I can continue viewing cached scores and metrics

**Given** the Finnhub API returns an error for a specific ticker
**When** refreshing that stock
**Then** I see an error message: "Unable to fetch data for {TICKER}. It may be invalid or delisted." (NFR19)
**And** other stocks in my portfolio continue refreshing normally
**And** the problematic stock shows its last cached data

**Given** a Finnhub API call fails
**When** the Edge Function handles the error
**Then** it retries up to 3 times with exponential backoff (100ms, 500ms, 2s) (NFR18)
**And** if all retries fail: returns cached data + error flag
**And** the frontend receives a user-friendly error message (NFR26)

**Given** Supabase is temporarily unavailable
**When** an authenticated user tries to save portfolio changes
**Then** the operation fails with error: "Unable to sync changes. Please try again when online." (NFR21)
**And** for read operations: a fallback to localStorage is attempted
**And** a banner appears: "Cloud sync unavailable. Working in offline mode."

**Given** I am authenticated and lose internet connectivity
**When** using the app
**Then** I see a warning banner: "You're offline. Changes won't sync until you're back online." (NFR21)
**And** read operations work with cached data
**And** write operations are queued (NFR22) and retry when connection is restored

**Given** an unexpected JavaScript error occurs
**When** the error is thrown
**Then** a React error boundary catches it (NFR27)
**And** I see a friendly error screen: "Something went wrong. Please refresh the page."
**And** a "Refresh Page" button is provided
**And** the error is logged to console for debugging

**Given** any error occurs in the app
**When** the error is displayed
**Then** the message is user-friendly, not technical (NFR26)
**And** no raw error codes or stack traces are shown to users
**And** actionable guidance is provided (e.g., "Try again", "Check your connection")

**Given** I trigger an operation that takes >1 second
**When** waiting for completion
**Then** a loading indicator is displayed (NFR28)
**And** the indicator clearly shows progress or activity
**And** the UI remains responsive (buttons disable, cursors change)

**Given** critical errors occur repeatedly
**When** the app detects failure patterns
**Then** an option to "Report Issue" may appear
**And** I can copy error details to share with support
**And** my data is never at risk (localStorage/Supabase protected)

---

### Story 6.5: Security Hardening

As a user,
I want my data and credentials to be secure,
So that I can trust Portfolio Assistant with my financial information.

**Acceptance Criteria:**

**Given** the app is deployed to production
**When** accessing the URL
**Then** all communication is over HTTPS only (NFR9)
**And** HTTP requests are automatically redirected to HTTPS by Vercel
**And** TLS 1.2+ is enforced

**Given** the frontend needs to communicate with Supabase
**When** making API requests
**Then** all requests use HTTPS
**And** the Supabase anon key is used (not service key) (NFR11)
**And** Row Level Security (RLS) enforces data isolation (NFR13)

**Given** the Edge Function needs to call Finnhub
**When** making API requests
**Then** the Finnhub API key is read from environment secrets (NFR10)
**And** the key is NEVER sent to the client
**And** the Edge Function validates requests before proxying to Finnhub

**Given** user passwords are created during signup
**When** Supabase Auth stores the password
**Then** passwords are hashed with bcrypt (NFR12)
**And** plaintext passwords are never stored
**And** password hashing is handled automatically by Supabase

**Given** a user is authenticated
**When** accessing portfolio data
**Then** RLS policies enforce `user_id = auth.uid()` (NFR13)
**And** users can ONLY see their own data
**And** attempting to access another user's data returns 403 Forbidden

**Given** a guest user is using the app
**When** portfolio data is saved
**Then** data stays in browser localStorage only (NFR14)
**And** guest data is never transmitted to any server
**And** localStorage is isolated per origin (browser security model)

**Given** API requests hit rate limits
**When** Finnhub returns 429 Too Many Requests
**Then** the error is handled gracefully with cached data (NFR15)
**And** users see: "API rate limit reached. Using recent cached data."
**And** sensitive error details are not exposed

**Given** the app logs information during operation
**When** errors or events occur
**Then** no sensitive data is logged (NFR16)
**And** API keys, passwords, and user emails are redacted from logs
**And** console logs in production are minimal

**Given** the Edge Function receives requests
**When** CORS is configured
**Then** only requests from the frontend domain are allowed
**And** CORS headers include: `Access-Control-Allow-Origin: https://portfolio-assistant.vercel.app`
**And** preflight requests (OPTIONS) are handled correctly

**Given** security headers are needed
**When** Vercel serves the app
**Then** headers are configured:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`
  **And** these headers are set in `vercel.json` or Vercel dashboard

**Given** Supabase anon key is used in client code
**When** inspecting network requests
**Then** the anon key is visible (expected and safe)
**And** RLS policies prevent unauthorized access despite key exposure
**And** service role key is NEVER used in client code (NFR11)

---

### Story 6.6: Monitoring & Operational Readiness

As a system administrator,
I want basic monitoring and operational procedures,
So that I can maintain the app and respond to issues.

**Acceptance Criteria:**

**Given** the app is running in production
**When** monitoring usage
**Then** Vercel Analytics is enabled to track:

- Page views
- Unique visitors
- Performance metrics (TTFB, FCP, LCP)
  **And** analytics data is available in Vercel dashboard

**Given** users encounter errors
**When** errors occur in production
**Then** errors are logged to browser console (development) or suppressed (production)
**And** critical errors trigger React error boundaries
**And** error logs can be reviewed in browser DevTools by users if needed

**Given** the Edge Function handles requests
**When** operations occur
**Then** Supabase Edge Function logs capture:

- Request count per endpoint
- Cache hit/miss ratio
- Errors and response times
  **And** logs are available in Supabase dashboard → Edge Functions → Logs

**Given** Finnhub API usage needs to be monitored
**When** checking API consumption
**Then** Finnhub dashboard shows API call count and rate limit status
**And** free tier limit (60 calls/min) is monitored to avoid overages
**And** server-side caching reduces API calls (NFR5)

**Given** database needs to be backed up
**When** running backup procedures
**Then** Supabase automatically backs up PostgreSQL database daily
**And** point-in-time recovery is available for 7 days (free tier) or 30 days (paid)
**And** manual backups can be triggered via Supabase dashboard

**Given** users report issues
**When** debugging problems
**Then** Vercel deployment logs show build and runtime errors
**And** Supabase logs show database queries and Edge Function errors
**And** browser console logs (captured by user) provide frontend errors
**And** a debugging checklist is documented in README

**Given** the app needs maintenance
**When** performing updates
**Then** a maintenance checklist includes:

- Update npm dependencies (security patches)
- Rotate API keys if compromised
- Review and optimize database indexes
- Monitor API usage vs. free tier limits
- Check Vercel build times and bundle sizes

**Given** the app experiences downtime
**When** Vercel or Supabase is unavailable
**Then** Vercel status page (status.vercel.com) shows service status
**And** Supabase status page (status.supabase.com) shows service status
**And** users see appropriate error messages (NFR21, NFR27)

**Given** the free tier limits are approached
**When** monitoring usage
**Then** Vercel free tier: 100GB bandwidth, 100 deployments/month
**And** Supabase free tier: 500MB database, 2GB file storage, 2 Edge Functions
**And** Finnhub free tier: 60 API calls/minute
**And** for 10 users, these limits are sufficient
**And** upgrade paths are documented if scale increases

**Given** browser compatibility needs to be tested
**When** validating the app
**Then** tests are run on:

- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)
  **And** all features work correctly on these browsers (NFR23)
  **And** mobile optimization is deferred to V2 (NFR25)

**Given** responsive design is tested
**When** viewing on different screen sizes
**Then** the app works on:

- Desktop (1024px+) - primary target
- Tablet (768px+) - supported
  **And** mobile (<768px) may be awkward but functional (NFR25)
  **And** slide-over panels become full-screen on mobile (NFR24)

---

**Epic 6 Complete!**
