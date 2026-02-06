# Project Context Analysis

## Requirements Overview

**Functional Requirements:**
Portfolio Assistant has 48 functional requirements across 8 capability areas, defining a personal investing decision-support tool for 10 users. Core capabilities include:

- **Portfolio Management** (7 FRs): Add/remove stocks, CSV/Excel import with smart column detection, portfolio-wide operations
- **Conviction Scoring** (7 FRs): Automated 4-factor scoring (Quality, Earnings, Analyst, Momentum), posture determination (Buy/Hold/Sell), confidence levels (High/Medium/Low), score explanations
- **Risk Warnings** (4 FRs): Concentration alerts (>15%, >25%), loss triggers (>8%, >15%), gain alerts (>25%)
- **Discovery Engine** (6 FRs): Curated "Quiet Compounders" and "Gold Mines" suggestions, dismissible cards, one-click add to portfolio
- **Stock Data Integration** (7 FRs): Real-time quotes, fundamentals, analyst recommendations, earnings history via Finnhub API
- **Authentication** (8 FRs): Hybrid model - guest mode (default, localStorage) + optional cloud sync (email/password, Supabase Auth)
- **UI/Navigation** (5 FRs): 2-tab SPA, slide-over details, guest/auth mode indicators
- **Data Persistence** (4 FRs): Dual storage (localStorage for guests, Supabase PostgreSQL for auth users), RLS enforcement, client-server consistency

**Non-Functional Requirements:**
28 NFRs across 4 categories will drive architectural decisions:

- **Performance** (7 NFRs):
  - Page load < 3 seconds on broadband
  - Data refresh < 5 seconds for 10-stock portfolio
  - Tab navigation < 100ms (instantaneous feel)
  - CSV import < 2 seconds for 100 stocks
  - 5-minute API response caching
  - Batch API calls where possible
  - Optimistic UI updates (cached data first, fresh data background)

- **Security** (8 NFRs):
  - Data encryption at rest (Supabase managed)
  - HTTPS-only communication
  - API keys in environment variables only (never in client)
  - Supabase anon key + RLS (no service key exposure)
  - Password hashing (bcrypt, Supabase Auth handles)
  - User data isolation (RLS policies)
  - Guest data stays in browser (never transmitted)
  - No sensitive data in logs/console

- **Integration Reliability** (6 NFRs):
  - Graceful API failure handling (cached data + error banner)
  - Exponential backoff retries (max 3 attempts)
  - Clear error messages for invalid tickers
  - Function continues if rate limit hit (uses cache)
  - Supabase connection failure → localStorage fallback
  - Offline queue for portfolio updates

- **Usability** (7 NFRs):
  - Desktop-first responsive (1024px+)
  - Tablet support (768px+)
  - Modern browser support (Chrome, Firefox, Safari, Edge)
  - No mobile optimization in MVP
  - User-friendly error messages (no raw codes)
  - Never crashes (all failures graceful)
  - Loading states for operations > 1 second

**Scale & Complexity:**

- **Primary domain:** Full-stack web application (React SPA + Supabase backend + Finnhub API integration)
- **Complexity level:** Medium
  - Brownfield enhancement (existing codebase with localStorage-only)
  - Hybrid architecture (guest + authenticated modes)
  - Personal tool constraint (10 users max, no scalability needed)
  - 10-15 hour build timeframe
  - LLM readiness for V2 (no re-architecture)
- **Estimated architectural components:** 6 major components (Frontend SPA, Supabase DB, Supabase Auth, Supabase Edge Functions, Finnhub API, Vercel hosting)

## Technical Constraints & Dependencies

**Brownfield Context:**

- Existing React 18 + Vite + TypeScript + Tailwind CSS 4 codebase
- Current storage: localStorage-only (no backend)
- Must preserve existing conviction scoring engine (v4, 4-factor model)
- Must maintain existing UI components and user workflows
- Migration path required for guest users to become authenticated users

**Technology Constraints:**

- **Frontend:** Vite + React 18 (already chosen, working well)
- **API Provider:** Finnhub (free tier, 60 calls/minute)
- **No budget for paid services** - Must use free tiers (Vercel, Supabase, Finnhub)
- **No domain purchase** - Vercel subdomain sufficient (`portfolio-assistant.vercel.app`)
- **Browser-only execution** - No server-side rendering, no native mobile apps

**Scalability Constraints (By Design):**

- **Max 10 users** - Personal tool, not a product
- **No multi-tenancy complexity** - Simple RLS per-user isolation sufficient
- **No CDN required** - Static assets via Vercel edge network sufficient
- **No load balancing** - Single Supabase instance handles 10 users easily

**API Rate Limit Management:**

- Finnhub: 60 calls/minute free tier
- 10 concurrent users × 10 stocks each = ~100 stocks total
- 5-minute client-side cache reduces API pressure
- Acceptable risk: If multiple users refresh simultaneously, some may hit rate limit and see cached data

**LLM Integration Preparation (V2):**

- Backend infrastructure (Supabase Edge Functions) must be deployable now
- API keys must be server-side only (never in browser)
- Edge Functions will call OpenAI/Claude APIs for:
  - AI-Powered Gold Mine Discovery (news → theme extraction)
  - News → Portfolio Action Engine (news → stock impact analysis)

## Cross-Cutting Concerns Identified

**1. Authentication & Authorization**

- **Concern:** Optional authentication must not block core functionality
- **Architectural Impact:** Dual code paths (guest vs. auth) throughout storage layer
- **Strategy:** Storage adapter pattern - same interface, different implementations

**2. Data Synchronization**

- **Concern:** Guest→Auth migration must preserve portfolio without data loss
- **Architectural Impact:** Migration helper, conflict resolution strategy
- **Strategy:** One-time import prompt on signup, localStorage data copied to Supabase

**3. API Integration & Rate Limiting**

- **Concern:** Finnhub 60 calls/min limit shared across 10 users
- **Architectural Impact:** Aggressive caching, batch operations, graceful degradation
- **Strategy:** 5-minute cache, display cached data instantly, fetch fresh in background

**4. Error Handling & Resilience**

- **Concern:** API failures must not crash app or lose user data
- **Architectural Impact:** Fallback strategies at every integration point
- **Strategy:** Try API → Fallback to cache → Display error banner + last known data

**5. Performance & Perceived Speed**

- **Concern:** Users expect instant UI response despite API latency
- **Architectural Impact:** Optimistic UI updates, background data fetching
- **Strategy:** Render with cached data immediately, refresh in background, update UI when fresh data arrives

**6. Security & Data Privacy**

- **Concern:** API keys exposed in browser = security breach
- **Architectural Impact:** All external API calls must route through backend (future state)
- **Current State:** Finnhub API key in client (acceptable risk for MVP, no user data at risk)
- **V2 State:** Edge Functions proxy all external API calls

**7. State Management**

- **Concern:** Complex conviction scoring logic must stay consistent across app
- **Architectural Impact:** Centralized scoring engine, immutable data flow
- **Strategy:** Single source of truth (convictionEngine.ts), React hooks for UI state

**8. Deployment & Environment Configuration**

- **Concern:** API keys need to be configured but kept secure
- **Architectural Impact:** Single environment configuration, no dev/prod separation needed
- **Strategy:** One `.env` file with all API keys (Finnhub, Supabase), never committed to Git, documented in README for setup

---
