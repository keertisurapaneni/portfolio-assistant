---
stepsCompleted: [step-01-init, step-02-context, step-03-starter, step-04-decisions, step-05-patterns, step-06-structure, step-07-stack, step-08-integration, step-09-deployment]
inputDocuments:
  - planning-artifacts/prd.md
  - planning-artifacts/sprint-change-proposal-2026-02-05.md
  - planning-artifacts/technical_spec_v1.md
  - planning-artifacts/ux-design-specification.md
  - planning-artifacts/product-brief-portfolio-assistant-2026-02-04.md
workflowType: 'architecture'
project_name: 'portfolio-assistant'
user_name: 'keerti'
date: '2026-02-05'
---

# Architecture Decision Document - Portfolio Assistant

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

---

## Project Context Analysis

### Requirements Overview

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

### Technical Constraints & Dependencies

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

### Cross-Cutting Concerns Identified

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

## Starter Template Evaluation

### Primary Technology Domain

Full-stack web application (React SPA + Supabase backend + API integration) - Brownfield context

### Existing Foundation (Already Established)

**Project Status:** Brownfield - existing codebase at `/Users/ksrisurapaneni/Git-RV/stock-website/app`

**Current Stack:**

- Vite 5.x + React 18.x + TypeScript 5.x
- Tailwind CSS 4.0 + shadcn/ui components
- localStorage-only data persistence
- Finnhub API integration (client-side)
- Conviction scoring engine (4-factor model)
- CSV/Excel import functionality

**Rationale for Existing Stack:**

- **Vite + React 18:** Fast dev experience, modern React features, simple configuration
- **TypeScript:** Type safety, better IDE support, self-documenting code
- **Tailwind CSS 4:** Rapid UI development, utility-first approach, design consistency
- **shadcn/ui:** Accessible components, copy-paste simplicity, full customization control
- **No framework overhead:** SPA architecture sufficient for 10-user personal tool

### Architectural Decisions Already Made

**Language & Runtime:**

- TypeScript 5.x with strict mode for type safety
- React 18.x with hooks-based component architecture
- Vite 5.x for fast development and optimized production builds

**Styling Solution:**

- Tailwind CSS 4.0 (utility-first, design tokens)
- shadcn/ui component library (accessible, customizable)
- Lucide React icons (consistent icon system)
- clsx + tailwind-merge for conditional styling

**Build Tooling:**

- Vite development server with HMR
- TypeScript compiler for type checking
- Automatic code splitting and tree-shaking
- CSS optimization and purging

**Code Organization:**

- Component-based architecture (`/src/components`)
- Business logic layer (`/src/lib`)
- Type definitions (`/src/types`)
- Centralized scoring engine (`lib/convictionEngine.ts`)
- API integration layer (`lib/stockApi.ts`)

**Development Experience:**

- Hot Module Replacement preserves state during development
- TypeScript IntelliSense for autocomplete
- Fast refresh for instant feedback
- No build step required for development

### Architectural Re-evaluation & Key Decisions

**Quick Dev Review:** The initial implementation used direct browser→Finnhub API calls. After architectural review, key decisions were reconsidered for security, performance, and V2 readiness.

**Decision 1: API Architecture**

- **Previous:** Browser → Finnhub API directly (API key in client)
- **New:** Browser → Supabase Edge Function → Finnhub API
- **Rationale:**
  - Security: API keys never exposed in browser
  - Shared caching: All 10 users benefit from centralized cache
  - V2 ready: Infrastructure for LLM API calls
  - Per-user rate limiting possible if needed

**Decision 2: Storage Strategy**

- **Approach:** Hybrid localStorage + Supabase (confirmed)
- **Rationale:**
  - Frictionless guest mode for evaluation
  - Optional cloud sync for multi-device access
  - No forced signup barrier
  - Prepares for V2 features requiring backend

**Decision 3: Caching Strategy**

- **Approach:** Server-side caching in Supabase `stock_cache` table
- **Rationale:**
  - 10 users checking AAPL = 1 API call (not 10)
  - Reduces Finnhub rate limit pressure
  - Faster response times (cache hit = no API call)
  - 15-minute TTL balances freshness with API efficiency

**Decision 4: Authentication Method**

- **Approach:** Email/Password (Supabase Auth)
- **Rationale:**
  - Fast login for daily power users
  - Familiar UX for all users
  - Browser password managers work seamlessly
  - "Remember me" option for 30-day sessions
  - Better for frequent access than magic links

### Additions Required for Secure Hybrid Architecture

**Backend Infrastructure (New):**

- Supabase project (PostgreSQL database + Auth + Edge Functions)
- Database schema with Row Level Security (RLS)
- Edge Function for secure API proxy (`fetch-stock-data`)
- Server-side cache table (`stock_cache`)

**Storage Layer Enhancement (Modification):**

- Storage adapter pattern (localStorage + Supabase implementations)
- Hybrid data persistence strategy
- Guest→Auth migration helper

**Authentication UI (New Components):**

- Sign Up modal (email/password)
- Login modal (email/password)
- Guest mode banner
- Account menu dropdown

**Deployment Configuration (New):**

- Vercel project configuration
- Environment variable setup (`.env` with Supabase URL, anon key, Finnhub key for Edge Function)
- Supabase connection configuration
- Build and deploy pipeline

**Note:** No project initialization needed - enhancements will be added to existing codebase at `/Users/ksrisurapaneni/Git-RV/stock-website/app`.

---

## Core Architectural Decisions

### Decision Priority Analysis

**Critical Decisions (Block Implementation):**

1. ✅ API Security Architecture - Edge Function proxy (not direct browser→Finnhub)
2. ✅ Storage Strategy - Hybrid localStorage + Supabase PostgreSQL
3. ✅ Authentication Method - Email/Password via Supabase Auth
4. ✅ Caching Strategy - Server-side in Supabase `stock_cache` table
5. ✅ Database Schema Design - Simple 2-table approach
6. ✅ Edge Function Architecture - Single proxy function

**Important Decisions (Shape Architecture):** 7. ✅ State Management - React hooks only (no Redux/Zustand) 8. ✅ Error Handling - Fallback chain with graceful degradation 9. ✅ Deployment Strategy - Vercel + Supabase, single environment

**Deferred Decisions (Post-MVP):**

- Historical score tracking (V2 - explicit in PRD)
- Mobile optimization (V2 - explicit in PRD)
- LLM API provider choice (V2 - OpenAI vs Claude TBD)
- Advanced monitoring/observability (not needed for 10 users)

---

### Data Architecture

**Database Choice:** **Supabase PostgreSQL**

- **Rationale:** Managed service, generous free tier (500MB), built-in Auth, Edge Functions ready for V2 LLM
- **Version:** Latest stable (PostgreSQL 15+)

**Schema Design:** **Simple 2-table approach**

```sql
-- Table 1: User stocks (portfolio data)
CREATE TABLE stocks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  name TEXT,
  shares NUMERIC,
  avg_cost NUMERIC,
  date_added TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, ticker)
);

-- Table 2: Shared stock data cache (all users benefit)
CREATE TABLE stock_cache (
  ticker TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  cached_at TIMESTAMP DEFAULT NOW()
);

-- Row Level Security (RLS)
ALTER TABLE stocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can only access their own stocks"
  ON stocks FOR ALL
  USING (auth.uid() = user_id);
```

**Rationale:**

- **2 tables sufficient** - `stocks` (per-user portfolio) + `stock_cache` (shared API cache)
- **JSONB for cache** - Flexible schema for Finnhub API responses, no schema updates needed
- **RLS enforcement** - Users can only see their own portfolio, enforced at database level
- **Shared cache** - All 10 users benefit from cached Finnhub data (massive API call reduction)
- **No score history table** - Deferred to V2 per PRD, keeps schema simple

**Data Validation:**

- **Client-side:** React state validation for form inputs
- **Server-side:** PostgreSQL constraints (UNIQUE, NOT NULL, REFERENCES)
- **API validation:** Finnhub returns 404 for invalid tickers, Edge Function handles gracefully

**Migration Approach:**

- **No database migrations** - Initial schema creation only (brownfield web app, not evolving schema)
- **Guest→Auth migration:** One-time copy from localStorage to Supabase on first signup
- **Data model evolution:** JSONB flexibility allows adding fields without schema changes

**Conviction Score Storage:**

- **Approach:** Calculate on-the-fly from cached stock data (no score persistence)
- **Rationale:** Scores derived from fresh data, historical tracking deferred to V2
- **Performance:** Calculation < 500ms per stock (per NFR requirement)

---

### Authentication & Security

**Authentication Method:** **Supabase Auth with Email/Password**

- **Rationale:** Fast login for daily users, familiar UX, browser password managers work seamlessly
- **Session Duration:** 30 days with automatic refresh tokens
- **"Remember me":** Enabled by default for convenience

**Authorization Pattern:** **Row Level Security (RLS)**

- **Policy:** `auth.uid() = user_id` enforced at database level
- **Rationale:** Zero-trust architecture, works even if client security bypassed
- **Scope:** Applies to all CRUD operations on `stocks` table

**Session Management:**

- **Storage:** Supabase stores session in browser localStorage
- **Refresh:** Automatic token refresh via Supabase SDK
- **Logout:** Clears session from localStorage

**Security Middleware:**

- **Frontend:** Supabase client validates session before API calls
- **Backend:** RLS policies double-check authorization at DB level
- **Edge Functions:** JWT token validation for authenticated endpoints (V2 only)

**Data Encryption:**

- **At Rest:** Supabase-managed AES-256 encryption
- **In Transit:** HTTPS enforced (Vercel + Supabase)
- **Client Storage:** localStorage data unencrypted (acceptable - local device scope only)

**API Security Strategy:**

- **Finnhub API Key:** Stored in Supabase Edge Function secrets (never exposed to browser)
- **Supabase Keys:** Only anon key in browser (service key server-side only)
- **Rate Limiting:** Edge Function can implement per-user limits if needed (not required for MVP)

---

### API & Communication Architecture

**API Design Pattern:** **Backend-for-Frontend (BFF) via Edge Functions**

**Architecture Flow:**

```
Browser → Supabase Edge Function → stock_cache table (check)
              ↓ (cache miss)
         Finnhub API (fetch fresh data)
              ↓
         stock_cache table (update)
              ↓
         Browser (return data)
```

**Edge Function: `fetch-stock-data`**

**Purpose:** Secure proxy for Finnhub API with server-side caching

**Responsibilities:**

1. Check `stock_cache` table for recent data (< 15 minutes old)
2. If cache hit: return cached data immediately
3. If cache miss: fetch from Finnhub API (4 parallel requests)
4. Update cache with fresh data
5. Return data to browser

**Request Format:**

```typescript
POST / functions / v1 / fetch - stock - data;
Body: {
  ticker: 'AAPL';
}
Response: {
  (quote, metrics, recommendations, profile, earningsHistory);
}
```

**Error Handling Standards:**

- **Invalid Ticker:** Return 404 with clear message
- **Finnhub Rate Limit:** Return cached data + 429 status
- **Finnhub Down:** Return cached data + 503 status
- **Network Error:** Retry 3 times with exponential backoff, then return error

**Rate Limiting Strategy:**

- **Finnhub Limit:** 60 calls/minute (free tier)
- **Cache Impact:** 15-minute cache reduces calls by ~90% (10 users checking AAPL repeatedly = 1 call per 15 min)
- **Acceptable Risk:** With caching, even if all 10 users refresh simultaneously, cache absorbs most load
- **No per-user limiting needed** - Cache strategy sufficient for MVP

**API Versioning:**

- **Not needed** - Internal Edge Function, no external consumers
- **Breaking changes:** Deploy and update frontend simultaneously

---

### Frontend Architecture

**State Management:** **React Hooks Only (No External Library)**

**Approach:**

- **Local State:** `useState` for component UI state
- **Side Effects:** `useEffect` for data fetching and subscriptions
- **Global State:** `useContext` for auth user session only
- **No Redux/Zustand/Jotai** - Unnecessary complexity for simple app

**Rationale:**

- 10-user personal tool, not complex enterprise app
- Most state is server-derived (fetch from Supabase)
- Context API sufficient for auth state sharing
- Keeps bundle size minimal and codebase simple

**Component Architecture:** **Feature-Based Organization**

```
/src/
  /components/
    /ui/              # shadcn/ui primitives (Button, Dialog, Card, etc.)
    /features/        # Feature-specific components
      StockCard.tsx
      StockDetail.tsx
      SuggestedFinds.tsx
      AddTickersModal.tsx
      ImportPortfolioModal.tsx
      GuestBanner.tsx
      AccountMenu.tsx
  /lib/
    convictionEngine.ts  # Scoring logic (pure functions)
    storageAdapter.ts    # Storage abstraction layer
    supabaseClient.ts    # Supabase initialization
  /types/
    index.ts             # TypeScript interfaces
  App.tsx                # Root component with routing
  main.tsx               # Entry point
```

**Component Principles:**

- **Presentational components** - Receive data via props, no business logic
- **Container pattern** - `App.tsx` handles data fetching and state
- **Pure functions** - All scoring logic in `convictionEngine.ts` (testable)
- **Adapter pattern** - Storage abstraction (`getStorageAdapter(user)`)

**Routing Strategy:** **State-Based Tab Routing (No React Router)**

**Approach:**

```typescript
const [activeTab, setActiveTab] = useState<'portfolio' | 'suggested'>('portfolio')
const [selectedStock, setSelectedStock] = useState<Stock | null>(null)

// Render based on state
{activeTab === 'portfolio' && <Dashboard />}
{activeTab === 'suggested' && <SuggestedFinds />}
{selectedStock && <StockDetail stock={selectedStock} onClose={() => setSelectedStock(null)} />}
```

**Rationale:**

- Only 2 tabs, no deep linking needed
- No URL state required (personal tool, not shareable links)
- Keeps bundle size minimal (React Router adds ~10KB)
- Simpler code, fewer dependencies

**Performance Optimization:**

| Optimization           | Decision                            | Rationale                                                |
| ---------------------- | ----------------------------------- | -------------------------------------------------------- |
| **Code Splitting**     | Not needed                          | Small app, 2 tabs, fast initial load already             |
| **Lazy Loading**       | Not needed                          | All components loaded upfront (< 100KB total)            |
| **Memoization**        | `useMemo` for conviction score only | Calculations run per stock on refresh                    |
| **Virtualization**     | Not needed                          | Max 20 stocks per user (no scrolling performance issues) |
| **Image Optimization** | Not applicable                      | No images in app                                         |

**Bundle Optimization:**

- **Vite tree-shaking:** Enabled by default (removes unused code)
- **Dynamic imports:** Not needed (fast initial load without splitting)
- **Dependency audit:** No heavy libraries (no charts, no animation libs)
- **Target bundle size:** < 200KB gzipped (achievable with current stack)

---

### Infrastructure & Deployment

**Hosting Strategy:**

| Component    | Provider         | Purpose                                        | Cost                           |
| ------------ | ---------------- | ---------------------------------------------- | ------------------------------ |
| **Frontend** | Vercel           | Static SPA hosting, CDN, automatic Git deploys | Free                           |
| **Backend**  | Supabase         | PostgreSQL + Auth + Edge Functions             | Free (up to 500MB DB, 50K MAU) |
| **Domain**   | Vercel subdomain | `portfolio-assistant.vercel.app`               | Free                           |

**Deployment Architecture:**

```
┌─────────────────────────────────────────────────┐
│                  Users (10)                     │
└────────────────────┬────────────────────────────┘
                     │ HTTPS
                     ▼
         ┌───────────────────────┐
         │   Vercel CDN          │ (Static SPA)
         │   portfolio-          │
         │   assistant.vercel.app│
         └───────────┬───────────┘
                     │
                     ▼
         ┌───────────────────────┐
         │  Supabase Project     │
         │  ├─ PostgreSQL (DB)   │
         │  ├─ Auth Service      │
         │  └─ Edge Functions    │
         │      └─ fetch-stock-  │
         │         data (proxy)  │
         └───────────┬───────────┘
                     │
                     ▼
         ┌───────────────────────┐
         │   Finnhub API         │
         │   (60 calls/min)      │
         └───────────────────────┘
```

**Deployment Pipeline:**

**Frontend (Automatic):**

1. Push to `main` branch on GitHub
2. Vercel webhook triggers build
3. Vite builds production bundle
4. Vercel deploys to CDN
5. Live at `portfolio-assistant.vercel.app`

**Backend (Manual - One-time):**

1. Create Supabase project via dashboard
2. Run SQL schema scripts (create tables, RLS policies)
3. Deploy Edge Function: `supabase functions deploy fetch-stock-data`
4. Set Edge Function secrets: `supabase secrets set FINNHUB_API_KEY=...`

**Environment Configuration:**

**Single `.env` file (no dev/prod separation):**

```bash
# Supabase connection (public, safe to expose)
VITE_SUPABASE_URL=https://[project-id].supabase.co
VITE_SUPABASE_ANON_KEY=[anon-key]

# Edge Function secrets (stored in Supabase, not in .env)
# FINNHUB_API_KEY=[your-key]  ← Set via: supabase secrets set
```

**Rationale:**

- Personal project, single deployment
- No dev/staging/prod environments needed
- Supabase anon key is safe in browser (RLS protects data)
- Finnhub key never touches browser (Edge Function only)

**CI/CD Pipeline:**

- **Trigger:** Push to `main` branch
- **Build:** Vercel automatically builds and deploys (no config needed)
- **Edge Functions:** Manual deploy via Supabase CLI (rare updates)
- **No automated testing** - Manual QA sufficient for 10 users
- **Rollback:** Vercel dashboard allows instant rollback to previous deployment

**Monitoring & Logging:**

- **Frontend Errors:** Browser console during development
- **Backend Logs:** Supabase dashboard shows Edge Function logs and errors
- **Uptime Monitoring:** Not needed (Vercel 99.99% uptime, Supabase 99.9% uptime)
- **Error Tracking:** Not needed (Sentry/Datadog overkill for 10 users)
- **Rationale:** Manual monitoring sufficient, users will report issues directly

**Scaling Strategy:**

- **None needed** - Designed for 10 users max (constraint as feature)
- **Free tier limits:**
  - Supabase: 500MB DB (sufficient for years), 50K monthly active users
  - Vercel: 100GB bandwidth/month (sufficient for 10 users)
  - Finnhub: 60 calls/min (cache reduces to <10 calls/min actual usage)
- **No CDN needed** - Vercel Edge Network (automatic)
- **No load balancing** - Single Supabase instance handles 10 users effortlessly

---

### Decision Impact Analysis

**Implementation Sequence:**

1. **Supabase Project Setup** (database + auth + edge functions infrastructure)
2. **Database Schema Creation** (run SQL scripts for tables and RLS policies)
3. **Edge Function Development** (`fetch-stock-data` proxy with caching logic)
4. **Edge Function Deployment** (deploy and configure secrets)
5. **Storage Adapter Layer** (interface + localStorage impl + Supabase impl)
6. **Auth UI Components** (signup, login, guest banner, account menu)
7. **Frontend Refactoring** (replace direct Finnhub calls with Edge Function calls)
8. **Migration Helper** (guest→auth portfolio import flow)
9. **Vercel Deployment Config** (environment variables, build settings)
10. **End-to-End Testing** (guest mode, auth mode, migration, API proxy)

**Cross-Component Dependencies:**

```
Edge Function ────▶ stock_cache table (check/update cache)
                └──▶ Finnhub API (fetch on cache miss)

Storage Adapter ───▶ Supabase Auth (check user session)
                └──▶ stocks table (authenticated user data)
                └──▶ localStorage (guest user data)

Frontend ──────────▶ Edge Function (via Supabase client.functions.invoke)
           └───────▶ Storage Adapter (data persistence abstraction)
           └───────▶ Supabase Auth (login/signup/session)

Vercel Deploy ─────▶ Environment variables (Supabase URL/key)
```

**Critical Path:**

1. Supabase project must exist **before** Edge Functions can be created
2. Edge Function must be deployed **before** frontend can call it
3. Database schema must exist **before** storage adapter can work
4. Auth must work **before** authenticated storage can be tested
5. All components must work **before** Vercel production deployment

---

## Implementation Patterns & Consistency Rules

### Purpose

This section defines conventions that AI agents and developers must follow to ensure consistency across the codebase. These patterns prevent conflicts when multiple agents or team members work on different features.

---

### Naming Patterns

**Database (Supabase PostgreSQL):**
- Tables: `snake_case` (e.g., `stocks`, `stock_cache`, `user_profiles`)
- Columns: `snake_case` (e.g., `ticker`, `created_at`, `cached_at`)
- Foreign Keys: `{table}_id` (e.g., `user_id`, `portfolio_id`)
- Indexes: `idx_{table}_{column}` (e.g., `idx_stocks_user_id`)
- Constraints: `{table}_{column}_{type}` (e.g., `stocks_ticker_unique`)

**API & Edge Functions:**
- Edge Function names: `kebab-case` (e.g., `fetch-stock-data`, `sync-portfolio`)
- Request/Response fields: `camelCase` (e.g., `{ ticker: "AAPL", currentPrice: 150.25 }`)
- Error codes: `SCREAMING_SNAKE_CASE` (e.g., `RATE_LIMIT_EXCEEDED`, `INVALID_TICKER`)

**Code (TypeScript/React):**
- Components: `PascalCase` (e.g., `Dashboard`, `StockDetail`, `AddTickersModal`)
- Files: `camelCase` (e.g., `convictionEngine.ts`, `stockApi.ts`, `storage.ts`)
- Functions: `camelCase` (e.g., `getConvictionResult`, `fetchStockData`)
- Variables: `camelCase` (e.g., `currentPrice`, `analystScore`)
- Constants: `SCREAMING_SNAKE_CASE` (e.g., `API_BASE_URL`, `CACHE_TTL_MINUTES`)
- Types/Interfaces: `PascalCase` (e.g., `Stock`, `ConvictionResult`, `StockWithConviction`)

---

### Structure Patterns

**Component Organization:**
```
src/
├── components/
│   ├── features/          # Feature-specific components
│   │   ├── Dashboard.tsx
│   │   ├── StockDetail.tsx
│   │   └── SuggestedFinds.tsx
│   ├── shared/            # Reusable UI components
│   │   ├── Button.tsx
│   │   └── Modal.tsx
│   └── layout/            # Layout components
│       ├── Header.tsx
│       └── Footer.tsx
├── lib/
│   ├── api/               # API clients and wrappers
│   │   ├── stockApi.ts
│   │   └── supabaseClient.ts
│   ├── engines/           # Business logic
│   │   ├── convictionEngine.ts
│   │   └── portfolioCalc.ts
│   └── utils/             # Utilities
│       ├── storage.ts
│       └── formatters.ts
├── types/
│   └── index.ts           # All TypeScript types
└── App.tsx
```

**Test Co-location:**
- Unit tests: `{filename}.test.ts` (e.g., `convictionEngine.test.ts`)
- Place tests adjacent to the code they test
- Integration tests: `/tests/integration/{feature}.test.ts`

---

### Format Patterns

**API Responses:**
- **Success:** Direct data response (no wrapper object)
  ```typescript
  // ✓ Correct
  { ticker: "AAPL", currentPrice: 150.25, qualityScore: 75 }
  
  // ✗ Wrong
  { success: true, data: { ticker: "AAPL", ... } }
  ```

- **Errors:** Consistent error object
  ```typescript
  { error: string, code: string, details?: any }
  // Example: { error: "Rate limit exceeded", code: "RATE_LIMIT_EXCEEDED" }
  ```

**JSON Field Conventions:**
- Use `camelCase` for all JSON fields (not `snake_case`)
- Dates: ISO 8601 strings (e.g., `"2026-02-05T10:30:00Z"`)
- Numbers: No string wrapping (e.g., `150.25`, not `"150.25"`)
- Booleans: `true`/`false` (not `1`/`0` or `"true"`/`"false"`)
- Null values: Use `null` (not `undefined` in JSON)

**Code Formatting:**
- Use Prettier defaults (already configured in project)
- Max line length: 100 characters
- Indent: 2 spaces
- Trailing commas: Always (ES5+)
- Semicolons: Required

---

### Communication Patterns

**State Management:**
- **Immutable Updates:** Always create new objects/arrays, never mutate
  ```typescript
  // ✓ Correct
  const updated = stocks.map(s => s.ticker === ticker ? { ...s, ...updates } : s);
  
  // ✗ Wrong
  const stock = stocks.find(s => s.ticker === ticker);
  stock.currentPrice = newPrice; // Mutation!
  ```

**Data Flow:**
- **Single Source of Truth:** Storage adapter is the only interface to persistence
  ```typescript
  // ✓ Correct - Use storage adapter
  import { getUserData, updateStock } from './lib/storage';
  
  // ✗ Wrong - Direct localStorage access
  localStorage.getItem('portfolio-assistant-data');
  ```

- **Edge Function Proxy:** All external API calls go through Edge Functions
  ```typescript
  // ✓ Correct - Call Edge Function
  const { data } = await supabase.functions.invoke('fetch-stock-data', { body: { ticker } });
  
  // ✗ Wrong - Direct API call
  fetch('https://finnhub.io/api/v1/quote?...');
  ```

---

### Process Patterns

**Error Handling:**
- Use fallback chain: API → Cache → Default
  ```typescript
  try {
    return await fetchFromAPI(ticker);
  } catch (apiError) {
    try {
      return await fetchFromCache(ticker);
    } catch (cacheError) {
      return getDefaultData(ticker); // Never throw to UI
    }
  }
  ```

**Loading States:**
- Show optimistic UI immediately
- Fetch data in background
- Update UI when data arrives
  ```typescript
  // Add stock immediately with defaults
  addStock({ ticker, name: ticker });
  setStocks(getUserData().stocks); // Show immediately
  
  // Fetch real data
  const data = await getStockData(ticker);
  updateStock(ticker, data);
  setStocks(getUserData().stocks); // Update UI
  ```

**Cache Strategy:**
- **Read:** Check cache first, fetch on miss
- **Write:** Update database and cache simultaneously
- **Invalidate:** 15-minute TTL on stock data (managed by Edge Function)

---

### Enforcement Guidelines

**Mandatory for All AI Agents:**

1. **Never bypass the storage adapter** - Always use `storage.ts` functions
2. **Never mutate state directly** - Use immutable patterns
3. **Never call external APIs directly** - Use Edge Functions
4. **Never use `any` type** - Explicitly type all data
5. **Never ignore TypeScript errors** - Fix them, don't suppress

**Code Review Checklist:**

- [ ] All naming follows conventions (database `snake_case`, code `camelCase`)
- [ ] No direct localStorage/sessionStorage access (use storage adapter)
- [ ] No direct Finnhub API calls (use Edge Function)
- [ ] All state updates are immutable
- [ ] Error handling has fallback chain
- [ ] Loading states show optimistic UI

---

### Examples & Anti-Patterns

**Example 1: Adding a Stock (Correct)**

```typescript
// ✓ Correct Flow
export async function handleAddStock(ticker: string) {
  // 1. Add to storage with defaults
  const stock = addStock({ ticker, name: ticker });
  
  // 2. Update UI immediately (optimistic)
  setStocks(getUserData().stocks);
  
  // 3. Fetch real data via Edge Function
  const { data, error } = await supabase.functions.invoke('fetch-stock-data', {
    body: { ticker }
  });
  
  if (!error && data) {
    // 4. Update storage immutably
    updateStock(ticker, {
      name: data.name,
      currentPrice: data.currentPrice,
      qualityScore: data.qualityScore,
      momentumScore: data.momentumScore,
      earningsScore: data.earningsScore,
      analystScore: data.analystScore
    });
    
    // 5. Refresh UI
    setStocks(getUserData().stocks);
  }
}
```

**Example 2: Adding a Stock (Anti-Pattern)**

```typescript
// ✗ WRONG - Multiple violations
async function addStockWrong(ticker: string) {
  // ✗ Direct localStorage access (bypass storage adapter)
  const data = JSON.parse(localStorage.getItem('portfolio-assistant-data'));
  
  // ✗ Direct mutation
  data.stocks.push({ ticker, name: ticker });
  
  // ✗ Direct API call (bypass Edge Function)
  const response = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${API_KEY}`);
  const quote = await response.json();
  
  // ✗ Mutation instead of immutable update
  data.stocks[data.stocks.length - 1].currentPrice = quote.c;
  
  // ✗ Direct localStorage write
  localStorage.setItem('portfolio-assistant-data', JSON.stringify(data));
  
  // ✗ No error handling, no optimistic UI, exposed API key
}
```

**Example 3: Database Query (Correct)**

```sql
-- ✓ Correct - snake_case, proper RLS
SELECT 
  ticker,
  current_price,
  quality_score,
  created_at
FROM stocks
WHERE user_id = auth.uid()
ORDER BY created_at DESC;
```

**Example 4: Database Query (Anti-Pattern)**

```sql
-- ✗ WRONG - Mixed case, no RLS consideration
SELECT 
  ticker,
  currentPrice,  -- ✗ camelCase in database
  quality_score
FROM stocks       -- ✗ No user_id filter (RLS bypass attempt)
ORDER BY ticker;
```

---

### Pattern Evolution

**When to Update These Patterns:**

- New architectural decisions require new patterns (e.g., adding Redis cache)
- Repeated bugs reveal pattern gaps (e.g., timezone handling not specified)
- Team/AI agents request clarification on ambiguous cases

**How to Propose Changes:**

1. Document the pattern gap or conflict
2. Propose solution with examples
3. Update this section via PR/agent workflow
4. Communicate to all active agents/developers

---

**Patterns Status:** ✅ Complete and enforced

---

## Project Structure & File Organization

### Repository Layout

```
portfolio-assistant/
├── app/                          # Frontend application (Vite + React + TypeScript)
│   ├── public/                   # Static assets
│   │   ├── favicon.ico
│   │   └── robots.txt
│   ├── src/
│   │   ├── components/           # React components
│   │   │   ├── features/         # Feature components (Dashboard, StockDetail, etc.)
│   │   │   ├── shared/           # Reusable UI (Button, Modal, Card, etc.)
│   │   │   └── layout/           # Layout components (Header, Footer, etc.)
│   │   ├── lib/                  # Core business logic and utilities
│   │   │   ├── api/              # API clients
│   │   │   │   ├── stockApi.ts          # Finnhub proxy via Edge Function
│   │   │   │   ├── supabaseClient.ts    # Supabase client setup
│   │   │   │   └── storageAdapter.ts    # Abstract storage interface
│   │   │   ├── engines/          # Business logic engines
│   │   │   │   ├── convictionEngine.ts  # Conviction scoring
│   │   │   │   └── portfolioCalc.ts     # Portfolio calculations
│   │   │   ├── utils/            # Utilities
│   │   │   │   ├── storage.ts           # localStorage implementation
│   │   │   │   ├── formatters.ts        # Number/date formatting
│   │   │   │   └── validators.ts        # Input validation
│   │   │   └── hooks/            # Custom React hooks (future)
│   │   │       └── useAuth.ts           # Auth hook
│   │   ├── types/                # TypeScript types
│   │   │   └── index.ts
│   │   ├── styles/               # Global styles
│   │   │   └── globals.css
│   │   ├── App.tsx               # Root component
│   │   └── main.tsx              # App entry point
│   ├── index.html                # HTML entry point
│   ├── vite.config.ts            # Vite configuration
│   ├── tailwind.config.js        # Tailwind CSS config
│   ├── tsconfig.json             # TypeScript config
│   └── package.json              # Frontend dependencies
│
├── supabase/                     # Supabase backend (database + edge functions)
│   ├── functions/                # Edge Functions (Deno)
│   │   ├── fetch-stock-data/     # Stock data proxy with caching
│   │   │   ├── index.ts          # Main Edge Function logic
│   │   │   └── README.md         # Function documentation
│   │   ├── sync-portfolio/       # Future: Sync guest→auth (V2)
│   │   └── _shared/              # Shared utilities across functions
│   │       ├── finnhub.ts        # Finnhub API wrapper
│   │       └── cache.ts          # Cache helper functions
│   ├── migrations/               # Database schema migrations
│   │   ├── 20260205000000_initial_schema.sql
│   │   ├── 20260205000001_rls_policies.sql
│   │   └── 20260205000002_indexes.sql
│   ├── config.toml               # Supabase local config
│   └── seed.sql                  # Test data (optional)
│
├── _bmad-output/                 # BMAD planning artifacts (not deployed)
│   └── planning-artifacts/
│       ├── prd.md
│       ├── architecture.md       # This document
│       ├── technical_spec_v1.md
│       └── ux-design-specification.md
│
├── docs/                         # Documentation (not deployed)
│   ├── DEPLOYMENT.md             # Deployment guide
│   ├── DEVELOPMENT.md            # Local dev setup
│   └── ARCHITECTURE.md           # Architecture overview
│
├── .env.example                  # Environment variable template
├── .gitignore
├── README.md                     # Project overview
├── package.json                  # Root workspace config (optional)
└── vercel.json                   # Vercel deployment config
```

---

### Component File Organization

**Feature Component Structure (Example: Dashboard):**

```
src/components/features/Dashboard.tsx
```

Each feature component is self-contained:
- Component logic
- Local state management
- Data fetching (via hooks)
- UI rendering

**Shared Component Structure (Example: Modal):**

```
src/components/shared/Modal.tsx
```

Shared components are:
- Reusable across features
- Stateless (props-driven)
- No business logic

---

### Library Organization

**API Layer (`src/lib/api/`):**
- `stockApi.ts` - Calls Supabase Edge Function for stock data
- `supabaseClient.ts` - Supabase client singleton
- `storageAdapter.ts` - Abstract interface for storage (localStorage or Supabase DB)

**Engine Layer (`src/lib/engines/`):**
- Pure functions (no side effects)
- Business logic only (conviction calculation, portfolio math)
- Thoroughly tested

**Utilities (`src/lib/utils/`):**
- Helper functions (formatters, validators)
- No business logic
- Framework-agnostic

---

### Edge Function Organization

**Edge Function Structure (fetch-stock-data):**

```typescript
// supabase/functions/fetch-stock-data/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  try {
    const { ticker } = await req.json()
    const supabase = createClient(...)
    
    // 1. Check cache
    const cached = await checkCache(supabase, ticker)
    if (cached) return new Response(JSON.stringify(cached))
    
    // 2. Fetch from Finnhub
    const data = await fetchFromFinnhub(ticker)
    
    // 3. Store in cache
    await updateCache(supabase, ticker, data)
    
    return new Response(JSON.stringify(data))
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: error.message, 
      code: 'FETCH_ERROR' 
    }), { status: 500 })
  }
})
```

**Shared Utilities (`supabase/functions/_shared/`):**
- Reusable across multiple Edge Functions
- Finnhub API wrapper
- Cache logic
- Error handling

---

### Database Schema Organization

**Migration Files:**
- One migration per logical change
- Timestamped for ordering
- Reversible (if possible)

**Example Migration:**

```sql
-- supabase/migrations/20260205000000_initial_schema.sql

-- Stocks table (user portfolios)
CREATE TABLE stocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  name TEXT,
  shares NUMERIC(20, 8),
  avg_cost NUMERIC(20, 8),
  current_price NUMERIC(20, 8),
  quality_score INTEGER,
  momentum_score INTEGER,
  earnings_score INTEGER,
  analyst_score INTEGER,
  analyst_rating JSONB,
  quarterly_eps JSONB,
  date_added TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, ticker)
);

-- Stock cache table (shared across users)
CREATE TABLE stock_cache (
  ticker TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_stocks_user_id ON stocks(user_id);
CREATE INDEX idx_stocks_ticker ON stocks(ticker);
CREATE INDEX idx_stock_cache_cached_at ON stock_cache(cached_at);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_stocks_updated_at BEFORE UPDATE ON stocks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_stock_cache_updated_at BEFORE UPDATE ON stock_cache
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

---

### Configuration Files

**Environment Variables (`.env`):**

```bash
# Supabase
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJxxx...

# Edge Function Secrets (set via Supabase CLI)
FINNHUB_API_KEY=d621d1pr01qgcobr8bggd621d1pr01qgcobr8bh0
```

**Vercel Configuration (`vercel.json`):**

```json
{
  "buildCommand": "cd app && npm run build",
  "outputDirectory": "app/dist",
  "framework": "vite",
  "env": {
    "VITE_SUPABASE_URL": "@supabase-url",
    "VITE_SUPABASE_ANON_KEY": "@supabase-anon-key"
  }
}
```

---

### File Naming Conventions

**Components:**
- `PascalCase.tsx` (e.g., `Dashboard.tsx`, `StockDetail.tsx`)

**Utilities & Logic:**
- `camelCase.ts` (e.g., `convictionEngine.ts`, `stockApi.ts`)

**Types:**
- `index.ts` (centralized in `src/types/`)

**Tests:**
- `{filename}.test.ts` (e.g., `convictionEngine.test.ts`)

**Edge Functions:**
- `kebab-case/` (folder) with `index.ts` inside

**Database:**
- `{timestamp}_{description}.sql` (e.g., `20260205000000_initial_schema.sql`)

---

### Import Organization

**Import Order (enforced by ESLint):**

```typescript
// 1. External dependencies
import { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';

// 2. Internal modules (absolute imports)
import { getConvictionResult } from '@/lib/engines/convictionEngine';
import { getUserData } from '@/lib/utils/storage';
import type { Stock, ConvictionResult } from '@/types';

// 3. Components (relative imports)
import { Dashboard } from './components/features/Dashboard';
import { Button } from './components/shared/Button';

// 4. Styles (if any)
import './styles/dashboard.css';
```

**Path Aliases (`tsconfig.json`):**

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@/components/*": ["src/components/*"],
      "@/lib/*": ["src/lib/*"],
      "@/types": ["src/types/index.ts"]
    }
  }
}
```

---

### Build & Deployment Artifacts

**Gitignored (not committed):**
- `app/dist/` - Vite build output
- `app/node_modules/` - Dependencies
- `.env` - Environment variables (use `.env.example` as template)
- `supabase/.temp/` - Local Supabase temp files

**Committed (version controlled):**
- All source code (`app/src/`, `supabase/functions/`)
- Configuration files (`.gitignore`, `tsconfig.json`, `vite.config.ts`)
- Database migrations (`supabase/migrations/`)
- Documentation (`docs/`, `_bmad-output/`)
- `.env.example` (template with no secrets)

---

**Structure Status:** ✅ Complete and documented

---

## Technology Stack & Versions

### Frontend Stack

**Core Framework:**
- **React** `18.3.1` - UI library
- **TypeScript** `5.6.3` - Type safety
- **Vite** `6.0.3` - Build tool and dev server

**UI & Styling:**
- **Tailwind CSS** `4.0.0-beta.7` - Utility-first CSS
- **shadcn/ui** `latest` - Accessible component library
- **Lucide React** `^0.468.0` - Icon library

**State & Data:**
- **React Hooks** (built-in) - State management (`useState`, `useEffect`, `useCallback`)
- **Supabase JS** `^2.46.2` - Supabase client for auth and API calls

**Type Definitions:**
- **@types/react** `^18.3.18`
- **@types/react-dom** `^18.3.5`

**Build & Dev Tools:**
- **ESLint** `^9.17.0` - Linting
- **TypeScript ESLint** `^8.18.2` - TS-specific linting
- **PostCSS** `^8.4.49` - CSS processing
- **Autoprefixer** `^10.4.20` - CSS vendor prefixes

---

### Backend Stack

**Platform:**
- **Supabase** - Backend-as-a-Service
  - PostgreSQL `15.x` - Relational database
  - PostgREST - Auto-generated REST API
  - GoTrue - Authentication service
  - Realtime - WebSocket subscriptions (V2)
  - Edge Functions - Serverless functions (Deno runtime)

**Edge Function Runtime:**
- **Deno** `1.40+` - JavaScript/TypeScript runtime
- **Supabase Functions** - Serverless deployment

**Database:**
- **PostgreSQL** `15.x` - Primary database
- **pg_stat_statements** - Query performance monitoring
- **Row Level Security (RLS)** - Data access control

---

### External Services

**Data Provider:**
- **Finnhub API** - Stock market data
  - Free tier: 60 calls/minute
  - Endpoints used:
    - `/quote` - Real-time quotes
    - `/stock/metric` - Financial metrics
    - `/stock/recommendation` - Analyst ratings
    - `/stock/earnings` - Earnings history

**Hosting:**
- **Vercel** - Frontend hosting
  - Edge Network (CDN)
  - Automatic deployments from Git
  - Environment variable management

---

### Development Tools

**Version Control:**
- **Git** - Source control
- **GitHub** - Repository hosting (assumed)

**Package Management:**
- **npm** `10.x` - JavaScript package manager
- **Supabase CLI** `1.x` - Supabase local development

**Local Development:**
- **Vite Dev Server** - Hot module replacement (HMR)
- **Supabase Local** - Local database and Edge Functions
- **Docker** (optional) - For running Supabase locally

---

### Browser Support

**Target Browsers:**
- Chrome/Edge `last 2 versions`
- Firefox `last 2 versions`
- Safari `last 2 versions`
- Mobile Safari (iOS) `last 2 versions`
- Chrome Android `last 2 versions`

**Minimum Requirements:**
- ES2020 support
- CSS Grid support
- Fetch API support
- LocalStorage support

---

### Dependencies Lock

**Frontend (`app/package.json`):**

```json
{
  "dependencies": {
    "@supabase/supabase-js": "^2.46.2",
    "lucide-react": "^0.468.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@eslint/js": "^9.17.0",
    "@types/react": "^18.3.18",
    "@types/react-dom": "^18.3.5",
    "@vitejs/plugin-react": "^4.3.4",
    "autoprefixer": "^10.4.20",
    "eslint": "^9.17.0",
    "eslint-plugin-react-hooks": "^5.1.0",
    "eslint-plugin-react-refresh": "^0.4.16",
    "globals": "^15.14.0",
    "postcss": "^8.4.49",
    "tailwindcss": "^4.0.0-beta.7",
    "typescript": "~5.6.3",
    "typescript-eslint": "^8.18.2",
    "vite": "^6.0.3"
  }
}
```

**Edge Functions (`supabase/functions/deno.json`):**

```json
{
  "imports": {
    "supabase": "https://esm.sh/@supabase/supabase-js@2",
    "cors": "https://deno.land/x/cors@v1.2.2/mod.ts"
  },
  "tasks": {
    "start": "deno run --allow-net --allow-env --watch index.ts"
  }
}
```

---

### Version Strategy

**Update Policy:**
- **Security updates:** Apply immediately
- **Minor/patch updates:** Monthly review and update
- **Major updates:** Evaluate impact, test thoroughly before upgrading

**Breaking Change Management:**
- Test in local environment first
- Review migration guides
- Update types and adjust code
- Document changes in changelog

**Dependency Auditing:**
- Run `npm audit` weekly
- Monitor Dependabot/Snyk alerts
- Review and address vulnerabilities within 7 days

---

### Performance Targets

**Frontend (Vercel):**
- First Contentful Paint (FCP): < 1.5s
- Largest Contentful Paint (LCP): < 2.5s
- Time to Interactive (TTI): < 3.5s
- Cumulative Layout Shift (CLS): < 0.1
- Bundle size: < 200KB gzipped

**Backend (Supabase):**
- Edge Function cold start: < 200ms
- Edge Function warm response: < 50ms
- Database query: < 100ms (p95)
- Cache hit rate: > 80%

**API (Finnhub):**
- Response time: < 500ms (with cache)
- Rate limit buffer: 20 calls/min reserved
- Timeout: 5 seconds

---

**Stack Status:** ✅ Complete and versioned

---

## Integration Points & API Contracts

### Frontend ↔ Supabase Edge Function

**Endpoint:** `fetch-stock-data`

**Request:**
```typescript
// Method: POST via supabase.functions.invoke()
{
  ticker: string  // e.g., "AAPL"
}
```

**Success Response (200):**
```typescript
{
  ticker: string,
  name: string,
  currentPrice: number,
  qualityScore: number,      // 0-100
  momentumScore: number,      // 0-100
  earningsScore: number,      // 0-100
  analystScore: number,       // 0-100
  analystRating: {
    buy: number,
    hold: number,
    sell: number,
    strongBuy: number,
    strongSell: number
  } | null,
  quarterlyEPS: Array<{
    date: string,         // ISO 8601
    actual: number,
    estimate: number
  }>
}
```

**Error Response (4xx/5xx):**
```typescript
{
  error: string,        // Human-readable message
  code: string,         // Machine-readable code
  details?: any         // Optional additional context
}

// Common error codes:
// - INVALID_TICKER: Ticker not found
// - RATE_LIMIT_EXCEEDED: Finnhub rate limit hit
// - API_ERROR: Finnhub API error
// - CACHE_ERROR: Database cache error
```

**Example Usage:**
```typescript
const { data, error } = await supabase.functions.invoke('fetch-stock-data', {
  body: { ticker: 'AAPL' }
});

if (error) {
  console.error('Failed to fetch stock data:', error);
  return;
}

console.log('Stock data:', data);
```

---

### Edge Function ↔ Finnhub API

**Quote Endpoint:**
```
GET https://finnhub.io/api/v1/quote
Query params: symbol={ticker}&token={API_KEY}
Response: { c: current_price, ... }
```

**Metrics Endpoint:**
```
GET https://finnhub.io/api/v1/stock/metric
Query params: symbol={ticker}&metric=all&token={API_KEY}
Response: { metric: { roic, margin, ... } }
```

**Recommendations Endpoint:**
```
GET https://finnhub.io/api/v1/stock/recommendation
Query params: symbol={ticker}&token={API_KEY}
Response: [{ buy, hold, sell, ... }]
```

**Earnings Endpoint:**
```
GET https://finnhub.io/api/v1/stock/earnings
Query params: symbol={ticker}&token={API_KEY}
Response: [{ actual, estimate, period, ... }]
```

**Rate Limits:**
- Free tier: 60 calls/minute
- Strategy: Cache for 15 minutes, batch requests

---

### Frontend ↔ Supabase Auth

**Login:**
```typescript
const { data, error } = await supabase.auth.signInWithPassword({
  email: string,
  password: string
});
```

**Signup:**
```typescript
const { data, error } = await supabase.auth.signUp({
  email: string,
  password: string
});
```

**Get Session:**
```typescript
const { data: { session } } = await supabase.auth.getSession();
```

**Logout:**
```typescript
const { error } = await supabase.auth.signOut();
```

---

### Frontend ↔ Supabase Database

**Storage Adapter Interface:**

```typescript
interface StorageAdapter {
  // Get all stocks for current user
  getStocks(): Promise<Stock[]>;
  
  // Add a stock
  addStock(stock: Omit<Stock, 'id' | 'dateAdded'>): Promise<Stock>;
  
  // Update a stock
  updateStock(ticker: string, updates: Partial<Stock>): Promise<Stock>;
  
  // Remove a stock
  removeStock(ticker: string): Promise<boolean>;
  
  // Clear all stocks
  clearAll(): Promise<void>;
}
```

**LocalStorage Implementation (Guest Mode):**
```typescript
class LocalStorageAdapter implements StorageAdapter {
  private readonly STORAGE_KEY = 'portfolio-assistant-data';
  
  getStocks(): Promise<Stock[]> {
    const data = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{"stocks":[]}');
    return Promise.resolve(data.stocks);
  }
  
  // ... other methods
}
```

**Supabase Implementation (Auth Mode):**
```typescript
class SupabaseStorageAdapter implements StorageAdapter {
  constructor(private supabase: SupabaseClient) {}
  
  async getStocks(): Promise<Stock[]> {
    const { data, error } = await this.supabase
      .from('stocks')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    return data || [];
  }
  
  // ... other methods with RLS automatic filtering by user_id
}
```

---

### Database Schema Contracts

**Table: `stocks`**

```sql
CREATE TABLE stocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  name TEXT,
  shares NUMERIC(20, 8),
  avg_cost NUMERIC(20, 8),
  current_price NUMERIC(20, 8),
  quality_score INTEGER CHECK (quality_score >= 0 AND quality_score <= 100),
  momentum_score INTEGER CHECK (momentum_score >= 0 AND momentum_score <= 100),
  earnings_score INTEGER CHECK (earnings_score >= 0 AND earnings_score <= 100),
  analyst_score INTEGER CHECK (analyst_score >= 0 AND analyst_score <= 100),
  analyst_rating JSONB,
  quarterly_eps JSONB,
  date_added TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT stocks_user_ticker_unique UNIQUE(user_id, ticker)
);
```

**RLS Policy:**
```sql
-- Users can only see/modify their own stocks
CREATE POLICY "Users manage own stocks"
  ON stocks
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

**Table: `stock_cache`**

```sql
CREATE TABLE stock_cache (
  ticker TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- No RLS - shared cache across all users
```

---

### Error Handling Contracts

**Frontend Error Handling:**

```typescript
// Always use try-catch for async operations
try {
  const data = await getStockData(ticker);
  // Success path
} catch (error) {
  if (error.code === 'RATE_LIMIT_EXCEEDED') {
    // Show rate limit message
  } else if (error.code === 'INVALID_TICKER') {
    // Show invalid ticker message
  } else {
    // Show generic error message
  }
}
```

**Edge Function Error Handling:**

```typescript
// Always return consistent error format
return new Response(
  JSON.stringify({ 
    error: 'Human-readable message',
    code: 'MACHINE_READABLE_CODE',
    details: { /* optional */ }
  }), 
  { 
    status: 400, // or 500
    headers: { 'Content-Type': 'application/json' }
  }
);
```

---

### Caching Contract

**Cache Key Format:**
- Stock cache: `ticker` (e.g., `"AAPL"`)

**Cache TTL:**
- Stock data: 15 minutes

**Cache Invalidation:**
- Automatic: TTL expiration (Edge Function checks `cached_at`)
- Manual: None needed (TTL handles freshness)

**Cache Hit Logic:**
```typescript
// Edge Function
const { data: cached } = await supabase
  .from('stock_cache')
  .select('*')
  .eq('ticker', ticker)
  .single();

if (cached && isWithinTTL(cached.cached_at, 15)) {
  return cached.data; // Cache hit
}

// Cache miss - fetch from Finnhub
```

---

**Integration Status:** ✅ Complete and documented

---

## Deployment & Operations

### Environment Setup

**Required Environment Variables:**

```bash
# Frontend (.env for local, Vercel dashboard for production)
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJxxx...

# Edge Functions (Supabase secrets)
FINNHUB_API_KEY=d621d1pr01qgcobr8bggd621d1pr01qgcobr8bh0
```

**Setting Secrets (Supabase):**
```bash
# Set Edge Function secret
supabase secrets set FINNHUB_API_KEY=d621d1pr01qgcobr8bggd621d1pr01qgcobr8bh0

# List secrets
supabase secrets list
```

**Setting Environment Variables (Vercel):**
- Dashboard → Project → Settings → Environment Variables
- Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
- Available in: Production, Preview, Development

---

### Deployment Process

**1. Supabase Setup:**

```bash
# Link to Supabase project
supabase link --project-ref xxx

# Run migrations
supabase db push

# Deploy Edge Functions
supabase functions deploy fetch-stock-data

# Set secrets
supabase secrets set FINNHUB_API_KEY=xxx
```

**2. Vercel Deployment:**

```bash
# Install Vercel CLI (optional)
npm i -g vercel

# Deploy (or use Git push for automatic deployment)
vercel --prod
```

**Automatic Deployment (Git):**
- Connect Vercel to GitHub repository
- Every push to `main` → automatic production deployment
- Every PR → automatic preview deployment

---

### Monitoring & Observability

**Supabase Dashboard:**
- Database performance: Query insights, slow queries
- Edge Functions: Logs, invocation count, errors
- Auth: User signups, login attempts
- Storage: Database size, table sizes

**Vercel Analytics:**
- Page views, unique visitors
- Core Web Vitals (LCP, FID, CLS)
- Deployment history, build logs

**Finnhub Monitoring:**
- API call count (manual check)
- Rate limit status (via error responses)

**Error Tracking:**
- Console errors in browser DevTools
- Supabase Edge Function logs
- Vercel Function logs

---

### Backup & Recovery

**Database Backup:**
- Supabase automatic daily backups (retained 7 days on free tier)
- Manual backup: `supabase db dump > backup.sql`
- Restore: `supabase db reset` then run SQL file

**Code Backup:**
- Git repository (GitHub) is source of truth
- All code version controlled

**Data Export (User-facing):**
- Users can export portfolio as JSON (localStorage or DB)
- Export button in UI (V2 roadmap)

---

### Scaling Considerations

**Current Limits (Free Tiers):**
- Supabase: 500MB DB, 50K MAU, 2GB Edge Function invocations/month
- Vercel: 100GB bandwidth, 100GB-hours compute
- Finnhub: 60 calls/min

**When to Upgrade:**
- **Database:** > 400MB usage (monitor via Supabase dashboard)
- **Users:** > 10 active users (constraint by design, no upgrade needed)
- **API:** > 50 calls/min sustained (upgrade Finnhub or add rate limiting)

**Upgrade Path:**
- Supabase Pro: $25/month (8GB DB, 100K MAU)
- Vercel Pro: $20/month (1TB bandwidth)
- Finnhub: $60/month (300 calls/min)

---

### Maintenance Tasks

**Weekly:**
- [ ] Check Supabase database size
- [ ] Review Edge Function error logs
- [ ] Monitor Finnhub API usage

**Monthly:**
- [ ] Review dependency updates (`npm outdated`)
- [ ] Apply security patches
- [ ] Review Vercel analytics

**Quarterly:**
- [ ] Database cleanup (if needed)
- [ ] Review and archive old logs
- [ ] Evaluate new features from providers

---

### Rollback Procedures

**Frontend Rollback (Vercel):**
- Dashboard → Deployments → Select previous deployment → Promote to Production

**Database Rollback (Supabase):**
- Restore from automatic backup (max 7 days)
- Or run migration rollback script (if reversible)

**Edge Function Rollback:**
- Redeploy previous version: `supabase functions deploy fetch-stock-data`

---

**Deployment Status:** ✅ Complete and operational

---

## Architecture Summary & Next Steps

### Document Completion Status

**✅ COMPLETE** - All architectural decisions documented and ready for implementation.

**Steps Completed:**
1. ✅ **Project Context Analysis** - Requirements, constraints, and brownfield status analyzed
2. ✅ **Starter Template Evaluation** - Existing tech stack documented and approved
3. ✅ **Core Architectural Decisions** - 7 major decisions finalized with rationale
4. ✅ **Implementation Patterns** - Naming, structure, format, communication, and process patterns defined
5. ✅ **Project Structure** - Complete file organization and directory layout documented
6. ✅ **Technology Stack** - All dependencies, versions, and tools specified
7. ✅ **Integration Points** - API contracts and data flows documented
8. ✅ **Deployment & Operations** - Setup, monitoring, and maintenance procedures defined

---

### Key Architectural Decisions Summary

| Decision Area | Choice | Rationale |
|--------------|--------|-----------|
| **API Architecture** | Supabase Edge Function proxy to Finnhub | Security (no exposed API keys), shared caching, V2 readiness |
| **Storage Strategy** | Hybrid (localStorage + Supabase DB) | Guest mode + optional auth, seamless migration path |
| **Caching** | Server-side in PostgreSQL (15-min TTL) | Reduce API calls, share across users, lower cost |
| **Authentication** | Supabase Auth (Email/Password) | Familiar UX, no magic link delays, suitable for daily use |
| **Database** | PostgreSQL with RLS | Security, multi-user data isolation, automatic user filtering |
| **Frontend Hosting** | Vercel | Easy deployment, automatic CDN, Git integration |
| **State Management** | React Hooks only | Sufficient for 10-user app, no external library needed |

---

### Implementation Readiness Checklist

**Prerequisites (Before Coding):**
- [x] PRD finalized and approved
- [x] Architecture decisions made
- [x] Technology stack selected
- [x] API contracts defined
- [ ] Epics & Stories breakdown (next workflow)
- [ ] Development environment setup guide
- [ ] CI/CD pipeline design (if needed)

**Infrastructure Setup (First Steps):**
1. [ ] Create Supabase project
2. [ ] Configure Vercel project
3. [ ] Obtain Finnhub API key (already have: `d621d1pr01qgcobr8bggd621d1pr01qgcobr8bh0`)
4. [ ] Set environment variables
5. [ ] Run database migrations

**Development Sequence:**
1. **Phase 1: Backend Foundation** (Supabase)
   - Set up database schema (migrations)
   - Deploy Edge Function (`fetch-stock-data`)
   - Test Edge Function with Finnhub integration
   - Configure RLS policies

2. **Phase 2: Storage Abstraction** (Frontend)
   - Create storage adapter interface
   - Implement localStorage adapter (guest mode)
   - Implement Supabase adapter (auth mode)
   - Test both modes

3. **Phase 3: Auth UI** (Frontend)
   - Build login/signup components
   - Guest mode banner
   - Account menu with logout
   - Migration flow (guest → auth)

4. **Phase 4: Frontend Refactoring**
   - Replace direct Finnhub calls with Edge Function calls
   - Integrate storage adapter
   - Test conviction scoring with new data flow
   - Test auto-refresh functionality

5. **Phase 5: Deployment**
   - Deploy Edge Functions to Supabase
   - Deploy frontend to Vercel
   - Configure environment variables
   - End-to-end testing

---

### Risk Register

**Technical Risks:**

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|---------|-----------|
| Finnhub rate limits | Medium | Medium | Cache for 15 min, monitor usage, upgrade if needed |
| Edge Function cold starts | Low | Low | Acceptable for 10 users, warm calls are fast |
| localStorage size limits | Low | Low | Limit to ~100 stocks per portfolio (well within 5-10MB) |
| Migration complexity (guest→auth) | Medium | Low | Simple JSON export/import, well-tested flow |

**Operational Risks:**

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|---------|-----------|
| Finnhub API downtime | Low | Medium | Fallback to cached data, show staleness warning |
| Supabase outage | Very Low | High | Free tier SLA is best-effort, monitor status page |
| Data loss (guest mode) | Low | Low | Clear messaging that localStorage is ephemeral |
| Exceeding free tier limits | Very Low | Low | Monitor usage, 10 users unlikely to hit limits |

---

### Open Questions & Future Decisions

**Resolved:**
- ✅ Authentication method: Email/Password
- ✅ Multi-environment setup: Single `.env` (personal project)
- ✅ Data source: Finnhub (via Edge Function proxy)
- ✅ Storage strategy: Hybrid (localStorage + Supabase)

**For V2 (Out of Scope for MVP):**
- Real-time price streaming (WebSocket)
- News → Portfolio Action Engine (LLM-powered)
- AI-Powered Gold Mine Discovery
- Historical conviction tracking
- Mobile app

**For Implementation Phase:**
- Exact RLS policy details (will be refined during migration creation)
- Edge Function error retry strategy (will be refined during testing)
- Guest→Auth migration UX copy (will be refined during UI build)

---

### Success Criteria

**Architecture is considered successful if:**

1. ✅ **Security:** No API keys exposed in frontend code
2. ✅ **Scalability:** Can handle 10 users without performance degradation
3. ✅ **Cost:** Stays within free tier limits ($0/month)
4. ✅ **Maintainability:** Clear patterns for AI agents and future developers
5. ✅ **User Experience:** Guest mode works offline, auth mode syncs across devices
6. ✅ **Reliability:** Fallback mechanisms for API failures

**Implementation Success Metrics:**
- All conviction scores load automatically on page refresh
- Import flow requires 0 manual data entry (full automation)
- Page load time < 2.5s (LCP)
- No console errors or warnings in production
- Tests pass for all core user journeys

---

### Next Workflows (BMAD Process)

**Completed:**
- ✅ Create Problem Frame
- ✅ Create Product Brief
- ✅ Create UX Design Specification
- ✅ Create PRD
- ✅ Create Architecture Document ← **YOU ARE HERE**

**Next Steps:**
1. **Epics & Stories Breakdown** - Break PRD into implementable user stories
2. **Implementation Readiness Check** - Final validation before coding
3. **Sprint Planning** - Prioritize stories and estimate effort
4. **Implementation** - Begin coding (or use Quick Dev agent)

**Recommended Next Action:**
```
/bmad-agent-bmm-architect
→ Select "ES" (Epics & Stories)
→ Break down architecture into implementable chunks
```

---

### Document Maintenance

**When to Update This Document:**
- New architectural decisions are made
- Technology stack changes (e.g., adding a new service)
- Patterns are refined based on implementation learnings
- Deployment process changes

**Version History:**
- `2026-02-05` - Initial architecture document created
- `2026-02-05` - All 9 steps completed (Context → Deployment)

---

**🎉 Architecture Document Complete**

This document now serves as the single source of truth for all architectural decisions, patterns, and implementation guidance for Portfolio Assistant. All AI agents and developers should refer to this document before making changes that affect system architecture.

---

_End of Architecture Decision Document_
