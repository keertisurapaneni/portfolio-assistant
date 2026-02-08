---
stepsCompleted:
  [
    step-01-init,
    step-02-discovery,
    step-03-success,
    step-04-journeys,
    step-05-domain,
    step-06-innovation,
    step-07-project-type,
    step-08-scoping,
    step-09-functional,
    step-10-nonfunctional,
    step-11-polish,
  ]
inputDocuments:
  - planning-artifacts/product-brief-portfolio-assistant-2026-02-04.md
  - planning-artifacts/sprint-change-proposal-2026-02-05.md
  - planning-artifacts/technical_spec_v1.md
  - planning-artifacts/ux-design-specification.md
briefCount: 1
sprintChangeProposalCount: 1
techSpecCount: 1
uxSpecCount: 1
classification:
  projectType: web_app
  domain: fintech
  complexity: medium
  projectContext: brownfield
workflowType: 'prd'
date: 2026-02-05
author: keerti
project_name: portfolio-assistant
---

# Product Requirements Document - Portfolio Assistant

**Author:** keerti  
**Date:** 2026-02-05

---

## Executive Summary

**Product Name:** Portfolio Assistant

**Vision:** Personal investing decision-support tool for conviction-based portfolio tracking. Helps 10 users identify when to act vs. when to hold steady by surfacing conviction changes and action signals.

**Target Users:** Active retail investors (Keerti, husband, 8 close friends/family) who hold 5-20 stocks and want clearer conviction signals without manual analysis.

**Core Differentiator:** Automated 4-factor conviction scoring with confidence levels, paired with actionable signals. Designed to outperform gut instinct and reduce delayed reactions.

**Deployment:** Vercel-hosted web app with hybrid storage (guest mode via localStorage, optional auth via Supabase for cloud sync).

---

## Success Criteria

### User Success (Behavioral)

**Daily Usage Indicators:**

- Opening app regularly (daily for power users, weekly for casual users)
- Acting on conviction score changes (not passive viewing)
- Using portfolio import to track positions
- Exploring Suggested Finds for new ideas

**Emotional Success Moments:**

- Relief: "I see my portfolio status at a glance"
- Confidence: "I held through volatility because conviction stayed strong"
- Clarity: "I exited early because the score flagged thesis drift"
- Discovery: "I found a stock I would have missed"

**The Real Test:**

> "After 30 days, do we still open it? If yes, it succeeded. If abandoned, it failed."

### Business Success (Personal Project Context)

**Observable Outcomes:**

- Earlier exits on broken thesis (selling before major drawdowns)
- Higher-conviction holds (not panic-selling during volatility)
- Better discovery (finding opportunities missed by passive scanning)
- Reduced regret ("I knew I should have sold" moments decrease)

**The Portfolio is the Scoreboard:** Performance improvements observable in real portfolio results over 3-6 months.

### Technical Success

**Deployment & Infrastructure:**

- All 10 invited users can access app via public URL
- App loads reliably with no broken deployments
- Both guest mode and authenticated mode function correctly
- Data persistence works (localStorage for guests, Supabase for authenticated)
- Guest→Auth migration successful when tested

**Performance & Reliability:**

- Conviction scores calculate correctly for all stocks
- Finnhub API integration stable (handles rate limits gracefully)
- No data loss incidents
- Page loads within 2 seconds on desktop

**LLM Readiness (V2 Preparation):**

- Supabase Edge Functions deployable and testable
- Backend infrastructure proven stable
- No re-architecture needed when LLM features are added

### 30-Day Success Check

Product succeeds if:

1. **Still using it** - Became part of routine (not abandoned)
2. **Accessible** - All invited users can access it when they want
3. **Reliable** - No major bugs or data loss
4. **Actionable** - At least one investing decision influenced by the tool
5. **Lighter cognitive load** - Feels helpful, not burdensome

**Failure Signals:**

- Stopped checking it after 2 weeks
- Users report "it's broken" or "I can't access my data"
- Multiple people say "I don't understand the scores"

---

## Product Scope

### MVP (v1) - Must Ship

**Core Features (Already Built):**

- Conviction Dashboard with 4-factor scoring (Quality, Earnings, Analyst, Momentum)
- Portfolio Import (CSV/Excel with smart column detection)
- Suggested Finds (Quiet Compounders + Gold Mines with expandable details)
- Risk Warning System (concentration, loss, gain alerts)
- Wall Street Analyst Consensus display
- Score explanation tooltips (info icons with calculation details)
- Confidence visual distinction (ring for High, dashed for Low)
- Current price tracking with manual refresh
- Clear Portfolio functionality
- Yahoo Finance links for each ticker

**Deployment Architecture (Adding Now):**

- Hybrid storage layer (localStorage + Supabase PostgreSQL)
- Optional authentication (email/password via Supabase Auth)
- Multi-user access via public Vercel URL
- Guest→Auth data migration helper
- Vercel deployment with automatic Git deploys
- Environment variable configuration

**MVP Complete When:** All features work + URL accessible to 10 users + both guest and auth modes functional

---

### V2 Features (Post-MVP, 1-2 months)

**AI-Powered Discovery:**

- LLM-based Gold Mine Discovery (analyze market news for emerging themes)
- News → Portfolio Action Engine (map news to holdings, suggest actions)

**Enhanced Tracking:**

- Historical conviction score tracking (view score changes over time)

**UX Improvements:**

- Mobile-responsive design
- Performance optimizations

---

### Out of Scope (Not Planned)

**Never building:**

- Scalability beyond 10 users
- Brokerage integration (automated trading)
- Social/collaborative features (shared portfolios, discussions)
- Multi-portfolio support (one portfolio per user is sufficient)

---

## User Journeys

### Journey 1: Primary User - Morning Portfolio Check

**User:** Active retail investor (Keerti, husband, or close friends/family)  
**Frequency:** Daily (power users) to weekly (casual users)  
**Time:** 2-5 minutes

**Opening Scene:** Morning. User opens Portfolio Assistant (bookmarked URL), hunting for actionable moments - not just "what happened," but "what should I do about it?"

**The Journey:**

1. **Scan Dashboard (5 seconds)**
   - Red arrows (↓) on conviction scores? → Something broke, investigate
   - Price spikes/drops? → Is this noise or signal?
   - Risk warnings (🚨)? → Over-concentrated? Stop-loss triggered?

2. **Drill into Changes (1-2 minutes)**
   - Click stock with big delta
   - See score breakdown: Which factor changed? (Quality? Earnings? Analyst?)
   - Read news summary: Why did price move?
   - See action signal: 🟢 Buying Opportunity | 🟡 Hold Steady | 🔴 Consider Exit

3. **Make Decision**
   - Price drop + Strong conviction → Buying opportunity (add to position)
   - Price spike + Weak conviction → Selling opportunity (trim or exit)
   - Conviction drop + Stable price → Early warning (thesis breaking)
   - Nothing urgent → Close app, confident doing nothing

4. **Check Suggested Finds (30 seconds)**
   - Scan new ideas
   - Dismiss [X] stocks not interested in (dismissed stocks hidden, new ones appear)
   - Add interesting finds to portfolio

5. **Close App**

**Emotional Success:**

> "I know where I stand. If something needs action, I see it immediately. If not, I'm confident doing nothing. Total time: 3 minutes."

**Critical Capabilities:**

- Fast load (< 2 seconds)
- Conviction deltas visible at a glance
- Price changes prominently displayed
- One-click drill-down to "what changed?"
- News summary paired with action signals
- Dismiss functionality for Suggested Finds

---

### Journey 2: Guest User - First-Time Exploration

**User:** Someone Keerti shared the URL with  
**Goal:** Evaluate if this tool is worth using  
**Time:** 5-10 minutes

**Opening Scene:** Friend receives text: "Try this portfolio tool I built: [URL]". Clicks link, curious but skeptical.

**The Journey:**

1. **Lands on Portfolio Assistant**
   - Clean, modern UI loads
   - Guest banner: "ℹ️ Using guest mode. Try all features without signing up."
   - Sees empty portfolio state

2. **Adds Test Tickers**
   - Clicks [+ Add Tickers]
   - Enters: AAPL, NVDA, TSLA (stocks they know)
   - Watches conviction scores calculate

3. **Explores Features**
   - Clicks NVDA → sees detailed breakdown
   - Reads news summary and action signal
   - Checks Suggested Finds
   - Dismisses a few suggestions, sees new ones appear

4. **Decision Point:**
   - Impressed: Bookmarks URL, decides to track their real portfolio
   - Maybe later: "Interesting, I'll come back"
   - Not for me: Closes tab

5. **Optional: Sign Up**
   - Realizes they want to access from phone too
   - Clicks [Sign Up]
   - Gets prompt: "Import your local portfolio?" → Yes
   - Now their data syncs to cloud

**Success:**

> "I understood what it does in 5 minutes. No commitment needed to try it."

**Critical Capabilities:**

- Zero-friction start (no login wall)
- Clear value visible with just 2-3 test tickers
- Guest mode banner (subtle, informative)
- One-click migration when ready to commit

---

### Journey Requirements Summary

| Capability                      | Why It's Essential                           |
| ------------------------------- | -------------------------------------------- |
| **Fast conviction calculation** | Users won't wait >5 seconds                  |
| **Price + News pairing**        | Action signals need context                  |
| **One-click drill-down**        | Quick investigation of changes               |
| **Guest mode (no login)**       | Frictionless evaluation                      |
| **Dismiss suggestions**         | Prevent stale suggestion fatigue             |
| **Optional cloud sync**         | Multi-device access when wanted              |
| **News → Action Engine**        | Translate information into decision guidance |

---

## Project Scoping & Phased Development

### MVP Strategy & Philosophy

**MVP Approach:** Experience MVP - Deliver a complete, polished user experience for the core use case (conviction-based portfolio tracking with multi-user access)

**Guiding Principle:**

> "Ship the working conviction dashboard to 10 users. Prove the scoring works. Add news intelligence after validation."

**Resource Requirements:** Single developer with AI assistance, 18-23 hours total

### MVP Feature Set (Phase 1)

**Core User Journeys Supported:**

- Primary user morning portfolio check (conviction scanning, action identification)
- Guest user first-time exploration and evaluation
- Optional authenticated user signup and data migration

**Must-Have Capabilities:**

**Existing Features (Already Built):**

- ✅ Conviction Dashboard with 4-factor automated scoring
- ✅ Portfolio Import (CSV/Excel with smart column detection)
- ✅ Suggested Finds (Quiet Compounders + Gold Mines with expandable details)
- ✅ Risk Warning System (concentration, loss, gain alerts)
- ✅ Wall Street Analyst Consensus display
- ✅ Score explanation tooltips (info icons)
- ✅ Confidence visual distinction (ring for High, dashed for Low)
- ✅ Current price tracking with manual refresh
- ✅ Clear Portfolio functionality
- ✅ Yahoo Finance links for each ticker

**Adding Now (Deployment Architecture):**

- 🔨 Vercel deployment with public URL (no domain purchase needed)
- 🔨 Hybrid storage layer (localStorage + Supabase PostgreSQL)
- 🔨 Optional authentication (Supabase Auth with email/password)
- 🔨 Guest→Auth migration helper with portfolio import prompt
- 🔨 Dismiss functionality for Suggested Finds (prevent stale suggestions)
- 🔨 Environment configuration (.env for Supabase and Finnhub keys)

**MVP Complete When:**

- All 10 invited users can access via public Vercel URL
- Both guest mode and authenticated mode work reliably
- No data loss incidents
- Core conviction scoring validated by real use

---

### Post-MVP Features

**Phase 2 (V2 - 1-2 Months Post-Launch):**

**News Intelligence Layer:**

- News → Portfolio Action Engine (LLM-powered)
- Fetch relevant news for each portfolio stock
- LLM analysis of news sentiment and impact
- Action recommendations: 🟢 Buying Opportunity | 🟡 Hold Steady | 🔴 Consider Exit
- Display news context paired with conviction scores

**AI-Powered Discovery:**

- Dynamic Gold Mine Discovery (LLM + market news analysis)
- Theme-driven opportunities based on current market events
- Automated refresh of suggestions overnight

**Enhanced Tracking:**

- Historical conviction score tracking
- Score change timeline visualization
- Trend analysis over weeks/months

**UX Improvements:**

- Mobile-responsive design
- Performance optimizations
- Enhanced data visualizations

**Phase 3 (Future Vision - If Wildly Successful):**

- LLM-assisted thesis writing and validation
- Brokerage position size suggestions
- Expanded user base (beyond 10-20 users)
- Potential for productization (not primary goal)

---

### Explicitly Out of Scope

**Never Building:**

- Scalability beyond 10-20 users (personal tool constraint as feature)
- Brokerage integration or automated trading (liability, complexity)
- Social/collaborative features (shared portfolios, discussions, social feeds)
- Multi-portfolio support (one portfolio per user is sufficient)
- Complex user management or admin panels

---

### Risk Mitigation Strategy

**Technical Risks:**

| Risk                    | Likelihood | Impact | Mitigation                                                |
| ----------------------- | ---------- | ------ | --------------------------------------------------------- |
| Supabase learning curve | Medium     | Low    | Use Quick Start guides, excellent documentation available |
| Data migration bugs     | Low        | Medium | Thorough testing, keep localStorage as backup             |
| Auth complexity         | Low        | Low    | Supabase handles heavy lifting                            |

**Fallback:** Keep localStorage working - Supabase is purely additive, not replacement.

**Market Risk:**

| Risk                                       | Likelihood | Impact | Mitigation                                      |
| ------------------------------------------ | ---------- | ------ | ----------------------------------------------- |
| Users don't adopt after launch             | Medium     | Medium | Start with 2 power users for validation         |
| Conviction scoring perceived as inaccurate | Medium     | High   | Built-in explanations, transparent calculations |

**Validation:** If power users (Keerti + husband) use daily for 30 days, expand to other 8 users.

**Resource Risk:**

| Risk                                 | Likelihood | Impact | Mitigation                                          |
| ------------------------------------ | ---------- | ------ | --------------------------------------------------- |
| Deployment takes longer than 8 hours | Medium     | Low    | Deployment is modular - can ship guest-only first   |
| Developer fatigue (20+ hours)        | Low        | Medium | Built with AI assistance, work in manageable chunks |

**Contingency:** Auth can be added post-launch if timeline pressure exists. Guest mode is fully functional standalone.

---

## Functional Requirements

### 1. Portfolio Management

- **FR1:** Users can add stocks to their portfolio by entering ticker symbols
- **FR2:** Users can import portfolios from CSV or Excel files
- **FR3:** Users can view all stocks in their portfolio with key metrics
- **FR4:** Users can remove individual stocks from their portfolio
- **FR5:** Users can clear their entire portfolio
- **FR6:** System auto-detects columns (ticker, shares, avg cost, name) from uploaded files
- **FR7:** Users can manually map columns if auto-detection fails

### 2. Conviction Scoring & Analysis

- **FR8:** System calculates conviction scores (0-100) for each stock using 4 automated factors
- **FR9:** System determines posture (Buy/Hold/Sell) based on conviction score
- **FR10:** System determines confidence level (High/Medium/Low) based on signal alignment
- **FR11:** Users can view detailed score breakdown by factor (Quality, Earnings, Analyst, Momentum)
- **FR12:** System displays score explanations via tooltips for each factor
- **FR13:** System tracks conviction score changes over time (displays delta)
- **FR14:** System generates 2-3 bullet rationale for each conviction score

### 3. Risk & Warning System

- **FR15:** System detects concentration risk (position > 15% or > 25% of portfolio)
- **FR16:** System detects loss alerts (down > 8% or > 15% from cost basis)
- **FR17:** System detects gain alerts (up > 25% from cost basis)
- **FR18:** Users can view warnings prominently on affected stock cards

### 4. Suggested Finds & Discovery

- **FR19:** System displays curated "Quiet Compounders" suggestions with expandable details
- **FR20:** System displays curated "Gold Mines" suggestions with theme context
- **FR21:** Users can dismiss individual suggestion cards
- **FR22:** System replaces dismissed suggestions with new ones from the pool
- **FR23:** Users can add suggested stocks to their portfolio with one click
- **FR24:** System displays stock descriptions and key metrics for suggestions

### 5. Stock Data Integration

- **FR25:** System fetches real-time stock quotes from Finnhub API
- **FR26:** System fetches company fundamentals (P/E, margins, ROE, EPS) from Finnhub
- **FR27:** System fetches Wall Street analyst recommendations from Finnhub
- **FR28:** System fetches quarterly earnings history from Finnhub
- **FR29:** System caches API responses for performance
- **FR30:** Users can manually refresh data for all stocks
- **FR31:** System provides Yahoo Finance links for each ticker

### 6. User Authentication & Access

- **FR32:** Users can access the full app as guests without creating an account
- **FR33:** Guest users' data persists in browser localStorage
- **FR34:** Users can sign up with email and password
- **FR35:** Users can log in with email and password
- **FR36:** Users can log out
- **FR37:** Authenticated users' portfolios sync to cloud database
- **FR38:** System prompts guest users to import their local portfolio when signing up
- **FR39:** System migrates guest portfolio data to cloud upon signup

### 7. User Interface & Navigation

- **FR40:** Users can navigate between "My Portfolio" and "Suggested Finds" tabs
- **FR41:** Users can view detailed stock information in slide-over panel
- **FR42:** Users can close slide-over panels to return to main view
- **FR43:** System displays guest mode banner for unauthenticated users
- **FR44:** System displays user account menu for authenticated users

### 8. Data Management & Persistence

- **FR45:** System persists portfolio data in localStorage for guest users
- **FR46:** System persists portfolio data in Supabase for authenticated users
- **FR47:** System enforces Row Level Security (users only see their own data)
- **FR48:** System maintains data consistency between client and server

---

## Non-Functional Requirements

### Performance

**User-Facing:**

- **NFR1:** Initial page load completes within 3 seconds on typical broadband
- **NFR2:** Stock data refresh completes within 5 seconds for a 10-stock portfolio
- **NFR3:** Tab navigation (Portfolio ↔ Suggested Finds) is instantaneous (<100ms)
- **NFR4:** CSV/Excel import processes within 2 seconds for files up to 100 stocks

**API Efficiency:**

- **NFR5:** System caches Finnhub API responses for 5 minutes to minimize rate limit hits
- **NFR6:** Batch API calls where possible to reduce total request count
- **NFR7:** Display cached data immediately while fetching fresh data in background

### Security

**Data Protection:**

- **NFR8:** All portfolio data encrypted at rest in Supabase
- **NFR9:** All API communication over HTTPS only
- **NFR10:** Finnhub API keys stored in environment variables, never in client code
- **NFR11:** Supabase API keys use anon key with Row Level Security (no service key in client)

**Authentication & Authorization:**

- **NFR12:** Passwords hashed with bcrypt before storage (handled by Supabase Auth)
- **NFR13:** Authenticated users can only access their own portfolio data (RLS enforced)
- **NFR14:** Guest users' localStorage data stays in browser, never transmitted

**API Key Management:**

- **NFR15:** Rate limiting handled gracefully with user-friendly error messages
- **NFR16:** No sensitive data (API keys, user credentials) logged or exposed in browser console

### Integration Reliability

**Finnhub API:**

- **NFR17:** System handles API failures gracefully (displays last cached data + error banner)
- **NFR18:** System retries failed API calls with exponential backoff (max 3 retries)
- **NFR19:** System displays clear error messages when ticker is invalid or not found
- **NFR20:** System continues functioning if API rate limit exceeded (uses cached data)

**Supabase Integration:**

- **NFR21:** System falls back to localStorage if Supabase connection fails
- **NFR22:** System queues portfolio updates locally if offline, syncs when connection restored

### Usability

**Browser Support:**

- **NFR23:** System works on latest versions of Chrome, Firefox, Safari, Edge
- **NFR24:** System is responsive on desktop (1024px+) and tablet (768px+)
- **NFR25:** Mobile support not required for MVP (can be awkward on small screens)

**Error Handling:**

- **NFR26:** All error states display user-friendly messages (no raw error codes)
- **NFR27:** System never crashes - all failures handled gracefully
- **NFR28:** Loading states clearly indicate progress for operations >1 second

---

## Web App Specific Requirements

### Project-Type Overview

Portfolio Assistant is a **Single Page Application (SPA)** built with React 18 + Vite, optimized for desktop browsers with future mobile optimization planned for V2.

### Technical Architecture

**Application Architecture:**

- Type: Single Page Application (SPA)
- Framework: React 18 with Vite build system
- Routing: Client-side routing (no page reloads between tabs)
- State Management: React hooks (useState/useEffect)
- Bundle Strategy: Code splitting for optimal load times

**Browser Support:**

- Supported: Modern browsers (Chrome, Firefox, Safari, Edge)
- Not Supported: IE11 or legacy browsers
- Rationale: Personal tool for 10 users, all use modern browsers

**Performance Targets:**

- Initial Load: < 2 seconds on broadband connection
- Tab Switching: Instant (no network calls)
- Data Refresh: < 1 second per stock
- Conviction Calculation: < 500ms per stock

**Responsive Design:**

- Primary: Desktop-first (1024px+)
- Secondary: Tablet support (768px+)
- Future: Mobile optimization (V2)

**SEO & Discoverability:**

- Not Required: App is accessed via direct URL sharing
- No public search presence needed: Personal tool for closed group

**Accessibility:**

- Level: Basic accessibility (semantic HTML, keyboard navigation)
- Not Required: Full WCAG 2.1 compliance
- Rationale: Personal tool, 10 known users with no accessibility needs

### Implementation Considerations

**State Persistence:**

- Guest Mode: Browser localStorage
- Authenticated Mode: Supabase PostgreSQL with Row Level Security
- Hybrid Strategy: Seamless migration path from local to cloud

**API Integration:**

- Stock Data: Finnhub API (60 calls/min free tier)
- News Data: Finnhub News API
- LLM Analysis: Groq (Llama 3.3 70B / Qwen3 32B) via Supabase Edge Functions
- Rate Limiting: Client-side throttling, backend caching

**Security:**

- API Keys: Server-side only (Supabase Edge Functions)
- User Data: Row Level Security in Supabase
- Authentication: Supabase Auth (email/password)
- HTTPS: Enforced via Vercel deployment

---

## Post-MVP Implementation Update (2026-02-05)

The following features were implemented during the initial build phase, exceeding the original MVP scope. These were originally planned as V2 or emerged from user feedback during development.

### Features Implemented Beyond MVP

#### AI-Powered Trade Signals (Originally V2)

**What was planned:** "LLM-based News → Portfolio Action Engine" in V2 phase.

**What was built:**

- Full AI trade signal system using Groq's Llama 3.3 70B model
- Two-model pipeline (70B primary, Qwen3 32B fallback) via Supabase Edge Function
- BUY/SELL/null signals per stock based on scores, price action, news, and position data
- Mechanical guardrails for stop-loss, profit-taking, and overconcentration
- Trigger-based analysis (skips AI call when no actionable catalyst)
- 4-hour caching per stock with prompt-version invalidation
- AI progress bar showing per-stock analysis during refresh
- Auto-retry for rate-limited stocks
- System prompt with few-shot examples, trading rules, and analyst persona

**Key Design Decisions:**

- AI is the single source of truth — no separate rule-based layer
- API keys never exposed to browser (all calls via Edge Function)
- Risk-profile-adjusted thresholds ensure consistency across views
- Weak stocks with fundamental problems = SELL, not "no action"

#### Market Movers Tab (New Feature)

**Not in original plan.** Added based on user request.

- Top 25 gainers and top 25 losers from Yahoo Finance Screener
- Sortable columns (Price, Change, Change %)
- Fetched via Supabase Edge Function (`scrape-market-movers`)
- Yahoo Finance links for each stock
- Manual refresh with last-updated timestamp

#### Risk Profile Settings (New Feature)

**Not in original plan.** Added to make trading thresholds user-adjustable.

- Three profiles: Aggressive, Moderate, Conservative
- Adjusts: stop-loss threshold, profit-take threshold, max position size
- Persists in localStorage
- All AI guardrails and trigger detection use risk-adjusted thresholds

| Setting      | Stop-Loss | Profit-Take | Max Position |
| ------------ | --------- | ----------- | ------------ |
| Aggressive   | -4%       | +25%        | 30%          |
| Moderate     | -7%       | +20%        | 25%          |
| Conservative | -5%       | +20%        | 20%          |

#### Portfolio Value Display (New Feature)

**Not in original plan.** Added to show dollar exposure.

- Per-stock position value (shares × current price) on stock cards
- Total portfolio value in dashboard header
- Total daily P&L change in dollar terms
- Only visible when user has entered share data

#### News Integration (Originally V2)

**What was planned:** "News Intelligence Layer" in V2.

**What was built:**

- Recent news headline on each stock card (clickable link to source)
- News context fed to AI for BUY/SELL decisions
- Company-specific filtering (removes generic market noise)
- Relative timestamps (e.g., "3h ago")

### Updated Technical Architecture

**AI Pipeline:**

- Client → Supabase Edge Function (`gemini-proxy`) → Groq API (70B or 32B fallback)
- Rate limiting: 4s inter-call delay, 15s cooldown on 429, server-side fallback retry
- System prompt maintained server-side in Edge Function

**Edge Functions Deployed:**

1. `fetch-stock-data` — Proxies Finnhub API with 15-minute server-side cache
2. `ai-proxy` — AI proxy with two-model pipeline (keeps Groq key server-side)
3. `scrape-market-movers` — Yahoo Finance Screener for gainers/losers
4. `fetch-yahoo-news` — Company-specific news from Yahoo Finance

**API Keys:**

- Finnhub key: Supabase secret (`FINNHUB_API_KEY`)
- Groq key: Supabase secret (`GROQ_API_KEY`)
- No API keys in `.env` or client-side code

### Updated Scope Assessment

**MVP + Implemented V2 Features:**

- ✅ Conviction Dashboard with 4-factor scoring
- ✅ Portfolio Import (CSV/Excel)
- ✅ Suggested Finds (Quiet Compounders + Gold Mines)
- ✅ Risk Warning System
- ✅ AI Trade Signals (BUY/SELL/null)
- ✅ Market Movers (Top Gainers/Losers)
- ✅ Risk Profile Settings
- ✅ Portfolio Value Display
- ✅ News Integration
- ✅ Vercel + Supabase deployment

**Implemented (since original PRD):**

- ✅ User authentication (Supabase Auth — email/password)
- ✅ Cloud storage for authenticated users (PostgreSQL + localStorage hybrid)
- ✅ Multi-device access via auth
- ✅ Trading Signals — Day/Swing trade (Gemini multi-key rotation + Twelve Data + Yahoo News)
- ✅ Broker Integration — SnapTrade (Schwab, IBKR, Robinhood & more), read-only position sync
- ✅ AI-Powered Suggested Finds (HuggingFace model cascade, server-side daily cache)

**Still Pending:**

- ⏳ Guest-to-auth data migration (auto-merge on signup)
- ⏳ Mobile-responsive design
- ⏳ Historical conviction score tracking
- ⏳ Additional AI data: volume vs average, DMA trends, earnings proximity
