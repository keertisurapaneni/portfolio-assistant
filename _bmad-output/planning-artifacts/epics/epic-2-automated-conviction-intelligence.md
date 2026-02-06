# Epic 2: Automated Conviction Intelligence

Users receive data-driven conviction scores (0-100) with detailed factor breakdowns, posture recommendations (Buy/Hold/Sell), confidence levels, and explanations for every score.

## Story 2.1: Supabase Edge Function for Secure Stock Data Fetching

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

## Story 2.2: Real-time Stock Quote Display

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

## Story 2.3: Company Fundamentals Display

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

## Story 2.4: Analyst Recommendations Display

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

## Story 2.5: Earnings History Display

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

## Story 2.6: Enhanced 4-Factor Conviction Engine

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

## Story 2.7: Score Breakdown UI with Explanatory Tooltips

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

## Story 2.8: Score Delta Tracking & Manual Refresh

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
