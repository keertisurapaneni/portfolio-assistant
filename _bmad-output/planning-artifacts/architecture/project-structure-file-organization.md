# Project Structure & File Organization

## Repository Layout

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

## Component File Organization

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

## Library Organization

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

## Edge Function Organization

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

## Database Schema Organization

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

## Configuration Files

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

## File Naming Conventions

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

## Import Organization

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

## Build & Deployment Artifacts

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
