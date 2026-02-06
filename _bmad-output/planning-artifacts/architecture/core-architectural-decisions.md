# Core Architectural Decisions

## Decision Priority Analysis

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

## Data Architecture

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

## Authentication & Security

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

## API & Communication Architecture

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

## Frontend Architecture

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

## Infrastructure & Deployment

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

## Decision Impact Analysis

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
