# Auth & Broker Integration — Product Requirements

## Overview

Optional email/password authentication with brokerage integration via SnapTrade. Users can log in to save their portfolio across devices and connect brokerages (Schwab, IBKR, Robinhood & more) to auto-import holdings. Guest mode continues to work without login.

## Goals

1. **Multi-device access** — Authenticated users' portfolios persist in the cloud (Supabase PostgreSQL)
2. **One-click brokerage import** — Eliminate manual ticker entry for users with existing brokerage accounts
3. **Zero friction for guests** — No forced signup; guest portfolios saved in browser localStorage as before
4. **Security** — API keys and broker credentials never touch the browser; RLS ensures per-user data isolation

## User Flows

### Guest Flow (unchanged)
1. User visits the app — no login required
2. Adds stocks manually (type tickers or import CSV/Excel)
3. Portfolio saved in browser localStorage
4. All features work: conviction scoring, AI signals, trade signals, suggested finds, market movers
5. Amber banner reminds guest to log in to save across devices

### Auth Flow
1. User clicks "Login" in header
2. Modal appears: Sign Up (email + password + confirm) or Log In (email + password)
3. On success: portfolio switches to cloud storage (PostgreSQL)
4. Header shows user icon with dropdown (email + logout)
5. Stocks persist across devices and browser sessions

### Broker Connect Flow (requires auth)
1. Authenticated user sees "Connect Brokerage" card in empty state, or broker banner when stocks exist
2. Clicks "Connect Broker" button
3. SnapTrade portal opens in popup — user authenticates with their brokerage
4. On return: positions auto-synced (ticker, shares, avg cost) into portfolio
5. User can manually sync, connect additional brokers, or disconnect

### Disconnect Flow
1. User clicks unlink icon next to broker controls
2. Confirmation dialog appears
3. On confirm: SnapTrade user deleted, broker_connections row removed
4. Portfolio data stays (only auto-sync stops)

## Supported Brokerages

Via SnapTrade aggregator — full list at [snaptrade.com/brokerage-integrations](https://snaptrade.com/brokerage-integrations):
- Charles Schwab
- Interactive Brokers (IBKR)
- Robinhood
- And many more (TD Ameritrade, Fidelity, E*TRADE, etc.)

## Scope

### In Scope
- Email/password authentication (Supabase Auth)
- Cloud portfolio storage with RLS
- SnapTrade broker connection (register, portal, disconnect)
- Read-only position sync (ticker, shares, avg cost)
- Guest mode preservation (no disruption)
- Login modal with autofill support
- Broker connect/sync/disconnect UI
- Guest save reminder banner
- Broker integration prompt in empty state and dashboard

### Out of Scope (Future)
- Phone/SMS authentication
- OAuth social login (Google, GitHub)
- Guest-to-auth portfolio migration (auto-merge on first signup)
- Broker write access (placing trades)
- Real-time position streaming
- Multiple portfolio support per user

## Success Criteria

- Guest users experience zero changes to existing functionality
- Authenticated users can access their portfolio from any device/browser
- Broker connect → sync completes in under 10 seconds
- Position data (ticker, shares, avg cost) matches brokerage source
- Disconnect removes sync but preserves portfolio data
