# Epic List

## Epic 1: Portfolio Management Foundation

Users can build and maintain their investment portfolio with ticker entry, CSV/Excel import with smart column detection, and portfolio-wide operations.

**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6, FR7

**User Value:** Complete portfolio management capability with both manual and bulk import options. Smart column detection reduces friction for users migrating from brokerages.

**Implementation Notes:** Enhances existing portfolio management with improved import flow, better validation, and position tracking support (shares, avg cost).

---

## Epic 2: Automated Conviction Intelligence

Users receive data-driven conviction scores (0-100) with detailed factor breakdowns, posture recommendations (Buy/Hold/Sell), confidence levels, and explanations for every score.

**FRs covered:** FR8, FR9, FR10, FR11, FR12, FR13, FR14, FR25, FR26, FR27, FR28, FR29, FR30, FR31

**User Value:** Automated, explainable conviction analysis powered by real-time market data. Users understand not just "what" the score is, but "why" it changed.

**Implementation Notes:**

- Integrates Finnhub API via Supabase Edge Function for security
- Implements server-side caching (15-min TTL) for performance
- Enhances existing conviction engine with 4-factor automation (Quality, Earnings, Analyst, Momentum)
- Provides Yahoo Finance links for external research

---

## Epic 3: Risk Monitoring & Alerts

Users receive automated risk warnings for concentration (>15%, >25%), losses (>8%, >15%), and significant gains (>25%) to support informed decision-making.

**FRs covered:** FR15, FR16, FR17, FR18

**User Value:** Proactive risk awareness without manual tracking. Users are alerted to portfolio imbalances and significant price movements.

**Implementation Notes:** Builds on portfolio data from Epic 1 and conviction scores from Epic 2. Risk calculations run client-side for instant feedback.

---

## Epic 4: Curated Stock Discovery

Users discover high-quality stock ideas through curated "Quiet Compounders" and "Gold Mines" suggestions with one-click portfolio addition.

**FRs covered:** FR19, FR20, FR21, FR22, FR23, FR24

**User Value:** Reduces research burden by surfacing pre-vetted ideas aligned with user's investment philosophy. Dismissible suggestions keep feed fresh.

**Implementation Notes:** Standalone discovery engine that integrates with portfolio management from Epic 1. Initial curation is manual; V2 can add AI-powered discovery.

---

## Epic 5: Cloud Sync & Multi-Device Access

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

## Epic 6: Production Deployment & Infrastructure

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

## Epic 12: AI-Powered Stock Discovery (Gemini Flash)

Transform Suggested Finds from static curated lists into a dynamic AI-powered discovery engine using Google Gemini Flash. Clean separation: Groq handles Portfolio AI Analysis, Gemini handles Suggested Finds discovery.

**Builds on:** Epic 4 (Curated Stock Discovery — "V2 AI-powered discovery")

**User Value:** Dynamic, market-aware stock suggestions that evolve with market themes. AI-identified Quiet Compounders and Gold Mines with investment theses, personalized to exclude stocks already in portfolio.

**Implementation Notes:**

- New Supabase Edge Function (`gemini-proxy`) for server-side Gemini API access
- Client-side discovery service with structured prompts per archetype
- React hook abstraction layer (`useSuggestedFinds`) for clean data flow
- 24-hour localStorage cache with manual refresh capability
- Fallback chain: AI fresh → AI cached → Clean empty state with message (no hardcoded data)
- UI enhancements: loading skeletons, AI badges, refresh button, timestamps

---
