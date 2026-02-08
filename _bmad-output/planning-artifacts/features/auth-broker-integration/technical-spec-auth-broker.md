# Auth & Broker Integration — Technical Specification

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌────────────────┐
│  React App   │────▶│  Supabase Auth   │     │  SnapTrade API │
│  (Frontend)  │     │  (JWT sessions)  │     │  (Aggregator)  │
└──────┬───────┘     └──────────────────┘     └───────┬────────┘
       │                                              │
       │  JWT in Authorization header                 │
       ▼                                              ▼
┌──────────────────────────────────────────────────────────────┐
│                   Supabase Edge Functions                     │
│                                                              │
│  broker-connect          broker-sync                         │
│  ├─ register user        ├─ list accounts                    │
│  ├─ generate portal URL  ├─ fetch positions per account      │
│  ├─ disconnect user      └─ upsert into portfolios table     │
│  └─ return status                                            │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                Supabase PostgreSQL (RLS)                      │
│                                                              │
│  portfolios           broker_connections     user_settings   │
│  ├─ user_id (FK)      ├─ user_id (FK)       ├─ user_id (FK) │
│  ├─ ticker            ├─ snaptrade_user_id   └─ risk_profile │
│  ├─ name              ├─ snaptrade_secret                    │
│  ├─ shares            └─ last_synced_at                      │
│  └─ avg_cost                                                 │
└──────────────────────────────────────────────────────────────┘
```

## Authentication

### Provider
- **Supabase Auth** — email/password provider
- Email confirmation disabled (instant login after signup)
- Minimum password: 8 characters
- JWT session with automatic refresh

### Frontend Implementation

| File | Purpose |
|------|---------|
| `app/src/lib/supabaseClient.ts` | Singleton Supabase client (shared across app) |
| `app/src/lib/auth.tsx` | AuthProvider context, useAuth hook, signUp/signIn/signOut |
| `app/src/components/AuthModal.tsx` | Login/signup modal with autofill support |

**Auth State Management:**
- `AuthProvider` wraps the app, listens to `onAuthStateChange`
- `useAuth()` hook returns `{ user, loading, signIn, signUp, signOut }`
- `App.tsx` switches storage source based on auth state

### Storage Strategy

| User Type | Read Source | Write Source | Market Data Cache |
|-----------|------------|--------------|-------------------|
| Guest | localStorage | localStorage | localStorage |
| Authenticated | PostgreSQL (portfolios table) | PostgreSQL | localStorage |

- Authenticated users always read tickers/positions from PostgreSQL
- Market data (prices, scores, news) cached in localStorage for both user types
- `loadStocks()` in App.tsx merges cloud positions with local market data cache

## Broker Integration (SnapTrade)

### API Authentication
- **HMAC-SHA256** signature using Web Crypto API (Deno-native)
- Signature input: `jsonSorted({ content, path, query })` — deterministic JSON with sorted keys
- `clientId` and `timestamp` passed as **query parameters**
- `Signature` passed as **HTTP header**

### Edge Functions

#### `broker-connect` (supabase/functions/broker-connect/index.ts)

| Action | Method | SnapTrade Endpoint | Description |
|--------|--------|-------------------|-------------|
| `connect` | POST | `/snapTrade/registerUser` + `/snapTrade/login` | Register user (if new) + generate portal URL |
| `status` | GET | — (DB lookup) | Check if user has a connected broker (`last_synced_at` exists) |
| `disconnect` | POST | `/snapTrade/deleteUser` | Delete SnapTrade user + remove DB row |

**Key detail:** A user is considered "connected" only if `last_synced_at` is non-null (having a `broker_connections` row just means SnapTrade registration, not an actual linked brokerage).

#### `broker-sync` (supabase/functions/broker-sync/index.ts)

1. Verify JWT → get user_id
2. Look up SnapTrade credentials from `broker_connections`
3. `GET /accounts` — list all connected brokerage accounts
4. For each account: `GET /accounts/{id}/positions` — fetch holdings
5. Normalize to `{ ticker, name, shares, avgCost }`
6. Upsert into `portfolios` table (ON CONFLICT update shares/avg_cost)
7. Update `last_synced_at` timestamp
8. Return normalized portfolio + sync stats to frontend

### Frontend Implementation

| File | Purpose |
|------|---------|
| `app/src/lib/brokerApi.ts` | API client for broker-connect and broker-sync Edge Functions |
| `app/src/lib/cloudStorage.ts` | Cloud storage adapter (CRUD on portfolios table via Supabase client) |
| `app/src/components/BrokerConnect.tsx` | Connect/sync/disconnect UI with status display |

**BrokerConnect.tsx states:**
- Not connected: "Connect Broker" button (blue)
- Connected: Sync button (green) + connect-another button + disconnect icon
- Loading/syncing: spinner states
- Error: ErrorBanner component

## Database Schema

### portfolios
```sql
CREATE TABLE portfolios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users NOT NULL,
  ticker text NOT NULL,
  name text,
  shares numeric,
  avg_cost numeric,
  date_added timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, ticker)
);
-- RLS: users see/modify own rows only
```

### broker_connections
```sql
CREATE TABLE broker_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users NOT NULL UNIQUE,
  snaptrade_user_id text NOT NULL,
  snaptrade_user_secret text NOT NULL,
  last_synced_at timestamptz,
  created_at timestamptz DEFAULT now()
);
-- RLS: users see/modify own row only
```

### user_settings
```sql
CREATE TABLE user_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users NOT NULL UNIQUE,
  risk_profile text DEFAULT 'moderate',
  updated_at timestamptz DEFAULT now()
);
-- RLS: users see/modify own row only
```

## Supabase Secrets

```bash
supabase secrets set SNAPTRADE_CLIENT_ID=your_client_id
supabase secrets set SNAPTRADE_CONSUMER_KEY=your_consumer_key
```

## Files Created/Modified

| File | Action | Purpose |
|------|--------|---------|
| `supabase/migrations/20260208000001_auth_broker.sql` | Created | Tables + RLS + triggers |
| `supabase/migrations/20260208000002_fix_portfolios_columns.sql` | Created | Add missing columns (ALTER TABLE) |
| `app/src/lib/supabaseClient.ts` | Created | Singleton Supabase client |
| `app/src/lib/auth.tsx` | Created | Auth context + useAuth hook |
| `app/src/lib/cloudStorage.ts` | Created | Cloud-backed portfolio CRUD |
| `app/src/lib/brokerApi.ts` | Created | Broker Edge Function API client |
| `app/src/components/AuthModal.tsx` | Created | Login/signup modal |
| `app/src/components/BrokerConnect.tsx` | Created | Broker connect/sync/disconnect UI |
| `supabase/functions/broker-connect/index.ts` | Created | SnapTrade register + portal + disconnect |
| `supabase/functions/broker-sync/index.ts` | Created | Fetch + normalize + upsert positions |
| `app/src/App.tsx` | Modified | Auth state, storage switching, header UI |
| `app/src/components/Dashboard.tsx` | Modified | Empty state cards, broker banner, guest reminder |

## Gotchas & Lessons Learned

1. **Web Crypto API over Node crypto** — Deno Edge Functions don't support `createHmac` from Node's crypto. Use native `crypto.subtle.importKey` + `crypto.subtle.sign` instead.
2. **SnapTrade query params** — `clientId` and `timestamp` must be query parameters, not headers. The SDK documentation is misleading.
3. **SnapTrade signature format** — HMAC input must be `jsonSorted({ content, path, query })` with deterministically sorted keys, not a concatenated string.
4. **SnapTrade login endpoint** — `userId` and `userSecret` go as query parameters for authentication.
5. **RLS requires explicit user_id** — When inserting into `portfolios`, always include `user_id` explicitly; the Supabase client doesn't auto-inject it.
6. **"Connected" vs "registered"** — A `broker_connections` row means SnapTrade registration. Check `last_synced_at IS NOT NULL` to determine if a broker is actually linked.
7. **Optional chaining for cloud stocks** — Cloud-only stocks may not exist in localStorage cache; always use `cached?.name` to prevent TypeError.
