# Technology Stack & Versions

## Frontend Stack

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

## Backend Stack

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

## External Services

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

## Development Tools

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

## Browser Support

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

## Dependencies Lock

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

## Version Strategy

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

## Performance Targets

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
