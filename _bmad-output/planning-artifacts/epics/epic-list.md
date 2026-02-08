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

## Epic 5: Auth & Broker Integration

Users can optionally log in (email/password) to save their portfolio across devices, and connect brokerage accounts (Schwab, IBKR, Robinhood & more) via SnapTrade to auto-import holdings. Guest mode works without login.

**FRs covered:** FR32, FR33, FR34, FR35, FR36, FR37, FR38, FR39, FR43, FR44, FR45, FR46, FR47, FR48

**User Value:** Frictionless onboarding with guest mode, optional cloud sync for multi-device access, and one-click brokerage connection to eliminate manual ticker entry. No forced signup barrier.

**Implementation Notes:**

- Supabase Auth (email/password) with JWT session management
- Hybrid storage strategy (localStorage for guests, PostgreSQL for auth users, both for market data cache)
- Row Level Security ensures per-user data isolation
- SnapTrade API integration via `broker-connect` and `broker-sync` Edge Functions
- HMAC-SHA256 authentication using Web Crypto API (Deno-native)
- `broker_connections` table stores SnapTrade credentials per user
- Read-only position sync (ticker, shares, avg cost) into `portfolios` table
- Popup-based SnapTrade connection portal flow
- UI: login modal, user menu, guest save reminder banner, broker connect/sync/disconnect controls

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

## Epic 12: AI-Powered Stock Discovery (HuggingFace)

Transform Suggested Finds from static curated lists into a dynamic AI-powered discovery engine using HuggingFace Inference API. Clean separation: Groq handles Portfolio AI Analysis, HuggingFace handles Suggested Finds discovery, Gemini handles Trading Signals.

**Builds on:** Epic 4 (Curated Stock Discovery — "V2 AI-powered discovery")

**User Value:** Dynamic, market-aware stock suggestions that evolve with market themes. AI-identified Quiet Compounders and Gold Mines with investment theses, personalized to exclude stocks already in portfolio.

**Implementation Notes:**

- Supabase Edge Function (`huggingface-proxy`) for server-side HuggingFace API access
- Model cascade: Qwen2.5-72B → Mixtral-8x7B → Llama-3.1-8B (fallback on rate limits)
- Server-side daily cache (`daily-suggestions` Edge Function + PostgreSQL) — same picks for all users each day
- Client-side discovery service with structured prompts per archetype
- 24-hour localStorage cache with manual refresh capability
- Fallback chain: AI fresh → AI cached → Clean empty state with message (no hardcoded data)
- UI enhancements: loading skeletons, AI badges, refresh button, timestamps

---

## Epic 13: Trading Signals — Auto / Day Trade / Swing Trade

Users get a **Trading Signals** experience with mode selection: **Auto | Day Trade | Swing Trade**. Auto mode (default) automatically picks Day or Swing based on volatility analysis. The entire pipeline (prompts, timeframes, risk rules, indicators) locks to the resolved mode.

**User Value:** Clear separation between intraday (minutes–hours, 1m/15m/1h, high news, high frequency) and swing (days–weeks, 4h/1d/1w, trend alignment, HOLD most of the time). Auto mode removes the burden of choosing. Full indicator engine (10 indicators) with market context provides institutional-grade analysis.

**Status:** ✅ Implemented

**Implementation Notes:**
- Auto mode picks Day or Swing via ATR% + ADX analysis on daily candles
- Full indicator engine: RSI, MACD, EMA, SMA, ATR, ADX, Volume Ratio, S/R, MA Crossover, Trend Classification
- Market context: SPY trend + VIX volatility in every analysis
- AI: Google Gemini (multi-key rotation + model cascade), enriched prompts with pre-computed indicators
- Output: 0-10 confidence, dual targets, bias label, bullish/neutral/bearish scenarios
- Frontend: mode persistence, in-memory caching (15m swing / 3m day), interactive charts, collapsible sections
- Full spec: `features/trading-signals/` (PRD + technical spec) and `docs/trade-signals-indicator-engine.md`

---
