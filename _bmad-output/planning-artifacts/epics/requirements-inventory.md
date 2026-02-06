# Requirements Inventory

## Functional Requirements

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

- FR40: Users can navigate between "My Portfolio", "Suggested Finds", and "Market Movers" tabs
- FR41: Users can view detailed stock information in slide-over panel
- FR42: Users can close slide-over panels to return to main view
- FR43: System displays guest mode banner for unauthenticated users
- FR44: System displays user account menu for authenticated users

**Data Management & Persistence (4 FRs):**

- FR45: System persists portfolio data in localStorage for guest users
- FR46: System persists portfolio data in Supabase for authenticated users
- FR47: System enforces Row Level Security (users only see their own data)
- FR48: System maintains data consistency between client and server

**AI-Powered Trade Signals (11 FRs) — IMPLEMENTED:**

- FR49: AI generates BUY/SELL/null trade signals per stock via LLM (Groq Llama 3.3 70B)
- FR50: AI signals display on main stock cards and detail view (single source of truth)
- FR51: Mechanical guardrails fire SELL for stop-loss, profit-take, overconcentration
- FR52: Guardrail thresholds adjust based on risk profile (Aggressive/Moderate/Conservative)
- FR53: AI calls routed through Supabase Edge Function (API keys never in browser)
- FR54: Two-model pipeline: 70B primary, 32B fallback on rate limit
- FR55: AI results cached 4 hours per stock with prompt-version invalidation
- FR56: Trigger detection skips AI call when no actionable catalyst
- FR57: AI progress bar shows per-stock analysis status
- FR58: Failed stocks auto-retry after cooldown
- FR59: System message includes few-shot examples, trading rules, analyst persona

**Market Intelligence (5 FRs) — IMPLEMENTED:**

- FR60: Display top 25 gainers and losers in sortable tables
- FR61: Fetch market movers from Yahoo Finance Screener via Edge Function
- FR62: Sortable columns (Price, Change, Change %)
- FR63: Yahoo Finance links for each mover
- FR64: Last-updated timestamp and manual refresh

**Risk Profile Settings (4 FRs) — IMPLEMENTED:**

- FR65: User-selectable risk profile (Aggressive/Moderate/Conservative)
- FR66: Risk profile adjusts stop-loss, profit-take, max position thresholds
- FR67: Risk profile persists in localStorage
- FR68: AI guardrails use risk-profile-adjusted thresholds

**Portfolio Value Display (4 FRs) — IMPLEMENTED:**

- FR69: Per-stock position value (shares × current price) on cards
- FR70: Total portfolio value in dashboard header
- FR71: Total daily P&L change in dollar terms
- FR72: Values hidden when no share data entered

**News Integration (4 FRs) — IMPLEMENTED:**

- FR73: Recent news headline on each stock card
- FR74: Clickable news links to source articles
- FR75: AI considers news in BUY/SELL decisions
- FR76: News filtered for company relevance

**Total: 76 Functional Requirements (48 original + 28 new)**

---

## Non-Functional Requirements

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

## Additional Requirements

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

- 3-tab SPA structure (My Portfolio, Suggested Finds, Market Movers)
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

## FR Coverage Map

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

**Epic 7 (AI-Powered Trade Signals):**

- FR49-FR59: All AI trade signal requirements

**Epic 8 (Market Movers):**

- FR60-FR64: Market movers display and data fetching

**Epic 9 (Risk Profile Settings):**

- FR65-FR68: Risk profile selection and threshold adjustment

**Epic 10 (Portfolio Value Display):**

- FR69-FR72: Position value and total portfolio value

**Epic 11 (News Integration):**

- FR73-FR76: News headlines and AI news context

**Total Coverage: 76 FRs + 28 NFRs + Infrastructure Requirements ✅**

---
