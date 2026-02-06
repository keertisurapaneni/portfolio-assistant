# Epic 6: Production Deployment & Infrastructure

Users can access Portfolio Assistant via public URL with enterprise-grade security, performance, and reliability.

## Story 6.1: Environment Configuration & Secrets Management

As a system administrator,
I want secure environment configuration for all API keys and service URLs,
So that sensitive credentials are never exposed in client code or version control.

**Acceptance Criteria:**

**Given** the frontend needs to connect to Supabase
**When** setting up environment variables
**Then** a `.env` file is created with:

- `VITE_SUPABASE_URL` = Supabase project URL
- `VITE_SUPABASE_ANON_KEY` = Supabase anonymous key (safe for client)
  **And** the `.env` file is added to `.gitignore` (never committed)
  **And** a `.env.example` file is committed with placeholder values as a template

**Given** the Edge Function needs to call Finnhub API
**When** setting up Edge Function secrets
**Then** the Finnhub API key is stored as a Supabase secret named `FINNHUB_API_KEY`
**And** the secret is set via Supabase CLI: `supabase secrets set FINNHUB_API_KEY=<key>`
**And** the secret is accessible in Edge Function via `Deno.env.get('FINNHUB_API_KEY')`
**And** the key is NEVER hardcoded in the Edge Function code

**Given** the app is deployed to Vercel
**When** configuring Vercel environment variables
**Then** all `VITE_*` variables are added to Vercel project settings
**And** environment variables are marked as production-only (not exposed in preview builds if sensitive)
**And** Vercel automatically injects these variables during build

**Given** a developer clones the repository
**When** setting up their local environment
**Then** they copy `.env.example` to `.env`
**And** they populate their own Supabase project URL and anon key
**And** they can run the app locally with their own Supabase instance
**And** README includes clear instructions for environment setup

**Given** API keys need to be rotated
**When** updating credentials
**Then** Supabase secrets can be updated via CLI without code changes
**And** Vercel environment variables can be updated in dashboard
**And** changes take effect on next deployment (Edge Function) or build (frontend)

**Given** the `.env` file exists locally
**When** running git status
**Then** `.env` does NOT appear in untracked files (correctly ignored)
**And** only `.env.example` is committed to version control

---

## Story 6.2: Vercel Deployment

As a system administrator,
I want to deploy the frontend to Vercel with automatic builds,
So that users can access Portfolio Assistant via a public URL with CDN performance.

**Acceptance Criteria:**

**Given** the frontend code is ready for deployment
**When** setting up Vercel project
**Then** a new Vercel project is created and linked to the GitHub repository
**And** the project name is descriptive (e.g., "portfolio-assistant")
**And** the root directory is set to `app/` (where Vite project lives)

**Given** Vercel needs to build the Vite app
**When** configuring build settings
**Then** build command is set to: `npm run build` or `vite build`
**And** output directory is set to: `dist`
**And** install command is set to: `npm install`
**And** Node.js version is set to 18.x or 20.x (latest LTS)

**Given** environment variables are needed for production
**When** configuring Vercel
**Then** all `VITE_*` variables are added in Vercel dashboard → Environment Variables
**And** variables are set for Production, Preview, and Development environments
**And** sensitive values are marked as sensitive (masked in UI)

**Given** code is pushed to the main branch
**When** GitHub triggers a webhook
**Then** Vercel automatically builds and deploys the app
**And** the deployment completes within 2-3 minutes
**And** the new version is live at the production URL (e.g., `portfolio-assistant.vercel.app`)

**Given** code is pushed to a feature branch
**When** Vercel detects the push
**Then** a preview deployment is created with a unique URL
**And** the preview URL is commented on the GitHub PR (if applicable)
**And** preview deployments use the same environment variables as production

**Given** a deployment succeeds
**When** the build completes
**Then** I can access the app at the Vercel URL
**And** the app loads within 3 seconds on typical broadband (NFR1)
**And** all assets are served via Vercel's global CDN
**And** HTTPS is enforced automatically by Vercel

**Given** a deployment fails (build error, etc.)
**When** Vercel detects the failure
**Then** the previous successful deployment remains live (no downtime)
**And** deployment logs are available in Vercel dashboard for debugging
**And** an email notification is sent to the project owner

**Given** custom domain is desired (optional)
**When** configuring DNS
**Then** a custom domain (e.g., `portfolioassistant.com`) can be added in Vercel
**And** Vercel automatically provisions SSL certificate
**And** DNS records point to Vercel's servers
**And** this is optional for MVP (Vercel subdomain is acceptable)

**Given** the app is deployed
**When** users access the URL
**Then** they see the Portfolio Assistant homepage
**And** guest mode works immediately (no login required)
**And** authenticated mode works after signup/login
**And** all features (portfolio, scoring, suggestions) are functional

---

## Story 6.3: Performance Optimizations

As a user,
I want the app to load quickly and respond instantly to my actions,
So that I have a smooth, professional experience.

**Acceptance Criteria:**

**Given** the app is accessed on typical broadband
**When** loading the homepage
**Then** initial page load completes within 3 seconds (NFR1)
**And** Time to First Byte (TTFB) is < 500ms
**And** Largest Contentful Paint (LCP) is < 2.5 seconds
**And** First Input Delay (FID) is < 100ms

**Given** I click on a tab (Portfolio ↔ Suggested Finds)
**When** the tab switch occurs
**Then** the transition completes within 100ms (NFR3)
**And** the navigation feels instantaneous
**And** no network requests are needed for tab switching

**Given** I trigger a data refresh for 10 stocks
**When** clicking "Refresh All"
**Then** all data is fetched and displayed within 5 seconds (NFR2)
**And** stocks update progressively as data returns (not all at once)
**And** loading indicators show progress for each stock

**Given** I import a CSV file with 100 stocks
**When** processing the import
**Then** the import completes within 2 seconds (NFR4)
**And** column detection happens instantly (<500ms)
**And** the preview modal appears without delay

**Given** Finnhub API responses are cached
**When** requesting data for the same ticker within 5 minutes
**Then** cached data is returned from Supabase (NFR5)
**And** no Finnhub API call is made
**And** the response is instant (<200ms)

**Given** multiple stocks need data simultaneously
**When** refreshing the portfolio
**Then** API calls are batched where possible (NFR6)
**And** at most 5 concurrent requests are made (rate limit consideration)
**And** remaining requests queue and execute after completion

**Given** I navigate to the Portfolio tab with existing data
**When** the tab loads
**Then** cached data is displayed immediately (NFR7)
**And** fresh data is fetched in the background
**And** UI updates seamlessly when fresh data arrives (no flickering)

**Given** I am viewing the stock detail slide-over
**When** the panel opens
**Then** it appears within 50ms with animation
**And** data sections load progressively (quote first, then metrics, then earnings)
**And** I can interact with loaded sections while others are still loading

**Given** the app bundle is built for production
**When** analyzing bundle size
**Then** main JS bundle is < 500KB gzipped
**And** code splitting is used for large libraries
**And** vendor chunks are separated for better caching
**And** unused code is tree-shaken by Vite

**Given** images and icons are used in the UI
**When** rendering the page
**Then** icons are SVG-based (Lucide React) for small file size
**And** no large images are used (icon-based UI)
**And** lazy loading is applied to below-the-fold content if needed

---

## Story 6.4: Error Handling & Graceful Degradation

As a user,
I want the app to handle errors gracefully without crashing,
So that I can continue working even when things go wrong.

**Acceptance Criteria:**

**Given** the Finnhub API is unavailable or rate-limited
**When** requesting stock data
**Then** the app displays cached data with a banner: "Showing cached data. API temporarily unavailable." (NFR17, NFR20)
**And** no error crashes the UI
**And** I can continue viewing cached scores and metrics

**Given** the Finnhub API returns an error for a specific ticker
**When** refreshing that stock
**Then** I see an error message: "Unable to fetch data for {TICKER}. It may be invalid or delisted." (NFR19)
**And** other stocks in my portfolio continue refreshing normally
**And** the problematic stock shows its last cached data

**Given** a Finnhub API call fails
**When** the Edge Function handles the error
**Then** it retries up to 3 times with exponential backoff (100ms, 500ms, 2s) (NFR18)
**And** if all retries fail: returns cached data + error flag
**And** the frontend receives a user-friendly error message (NFR26)

**Given** Supabase is temporarily unavailable
**When** an authenticated user tries to save portfolio changes
**Then** the operation fails with error: "Unable to sync changes. Please try again when online." (NFR21)
**And** for read operations: a fallback to localStorage is attempted
**And** a banner appears: "Cloud sync unavailable. Working in offline mode."

**Given** I am authenticated and lose internet connectivity
**When** using the app
**Then** I see a warning banner: "You're offline. Changes won't sync until you're back online." (NFR21)
**And** read operations work with cached data
**And** write operations are queued (NFR22) and retry when connection is restored

**Given** an unexpected JavaScript error occurs
**When** the error is thrown
**Then** a React error boundary catches it (NFR27)
**And** I see a friendly error screen: "Something went wrong. Please refresh the page."
**And** a "Refresh Page" button is provided
**And** the error is logged to console for debugging

**Given** any error occurs in the app
**When** the error is displayed
**Then** the message is user-friendly, not technical (NFR26)
**And** no raw error codes or stack traces are shown to users
**And** actionable guidance is provided (e.g., "Try again", "Check your connection")

**Given** I trigger an operation that takes >1 second
**When** waiting for completion
**Then** a loading indicator is displayed (NFR28)
**And** the indicator clearly shows progress or activity
**And** the UI remains responsive (buttons disable, cursors change)

**Given** critical errors occur repeatedly
**When** the app detects failure patterns
**Then** an option to "Report Issue" may appear
**And** I can copy error details to share with support
**And** my data is never at risk (localStorage/Supabase protected)

---

## Story 6.5: Security Hardening

As a user,
I want my data and credentials to be secure,
So that I can trust Portfolio Assistant with my financial information.

**Acceptance Criteria:**

**Given** the app is deployed to production
**When** accessing the URL
**Then** all communication is over HTTPS only (NFR9)
**And** HTTP requests are automatically redirected to HTTPS by Vercel
**And** TLS 1.2+ is enforced

**Given** the frontend needs to communicate with Supabase
**When** making API requests
**Then** all requests use HTTPS
**And** the Supabase anon key is used (not service key) (NFR11)
**And** Row Level Security (RLS) enforces data isolation (NFR13)

**Given** the Edge Function needs to call Finnhub
**When** making API requests
**Then** the Finnhub API key is read from environment secrets (NFR10)
**And** the key is NEVER sent to the client
**And** the Edge Function validates requests before proxying to Finnhub

**Given** user passwords are created during signup
**When** Supabase Auth stores the password
**Then** passwords are hashed with bcrypt (NFR12)
**And** plaintext passwords are never stored
**And** password hashing is handled automatically by Supabase

**Given** a user is authenticated
**When** accessing portfolio data
**Then** RLS policies enforce `user_id = auth.uid()` (NFR13)
**And** users can ONLY see their own data
**And** attempting to access another user's data returns 403 Forbidden

**Given** a guest user is using the app
**When** portfolio data is saved
**Then** data stays in browser localStorage only (NFR14)
**And** guest data is never transmitted to any server
**And** localStorage is isolated per origin (browser security model)

**Given** API requests hit rate limits
**When** Finnhub returns 429 Too Many Requests
**Then** the error is handled gracefully with cached data (NFR15)
**And** users see: "API rate limit reached. Using recent cached data."
**And** sensitive error details are not exposed

**Given** the app logs information during operation
**When** errors or events occur
**Then** no sensitive data is logged (NFR16)
**And** API keys, passwords, and user emails are redacted from logs
**And** console logs in production are minimal

**Given** the Edge Function receives requests
**When** CORS is configured
**Then** only requests from the frontend domain are allowed
**And** CORS headers include: `Access-Control-Allow-Origin: https://portfolio-assistant.vercel.app`
**And** preflight requests (OPTIONS) are handled correctly

**Given** security headers are needed
**When** Vercel serves the app
**Then** headers are configured:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`
  **And** these headers are set in `vercel.json` or Vercel dashboard

**Given** Supabase anon key is used in client code
**When** inspecting network requests
**Then** the anon key is visible (expected and safe)
**And** RLS policies prevent unauthorized access despite key exposure
**And** service role key is NEVER used in client code (NFR11)

---

## Story 6.6: Monitoring & Operational Readiness

As a system administrator,
I want basic monitoring and operational procedures,
So that I can maintain the app and respond to issues.

**Acceptance Criteria:**

**Given** the app is running in production
**When** monitoring usage
**Then** Vercel Analytics is enabled to track:

- Page views
- Unique visitors
- Performance metrics (TTFB, FCP, LCP)
  **And** analytics data is available in Vercel dashboard

**Given** users encounter errors
**When** errors occur in production
**Then** errors are logged to browser console (development) or suppressed (production)
**And** critical errors trigger React error boundaries
**And** error logs can be reviewed in browser DevTools by users if needed

**Given** the Edge Function handles requests
**When** operations occur
**Then** Supabase Edge Function logs capture:

- Request count per endpoint
- Cache hit/miss ratio
- Errors and response times
  **And** logs are available in Supabase dashboard → Edge Functions → Logs

**Given** Finnhub API usage needs to be monitored
**When** checking API consumption
**Then** Finnhub dashboard shows API call count and rate limit status
**And** free tier limit (60 calls/min) is monitored to avoid overages
**And** server-side caching reduces API calls (NFR5)

**Given** database needs to be backed up
**When** running backup procedures
**Then** Supabase automatically backs up PostgreSQL database daily
**And** point-in-time recovery is available for 7 days (free tier) or 30 days (paid)
**And** manual backups can be triggered via Supabase dashboard

**Given** users report issues
**When** debugging problems
**Then** Vercel deployment logs show build and runtime errors
**And** Supabase logs show database queries and Edge Function errors
**And** browser console logs (captured by user) provide frontend errors
**And** a debugging checklist is documented in README

**Given** the app needs maintenance
**When** performing updates
**Then** a maintenance checklist includes:

- Update npm dependencies (security patches)
- Rotate API keys if compromised
- Review and optimize database indexes
- Monitor API usage vs. free tier limits
- Check Vercel build times and bundle sizes

**Given** the app experiences downtime
**When** Vercel or Supabase is unavailable
**Then** Vercel status page (status.vercel.com) shows service status
**And** Supabase status page (status.supabase.com) shows service status
**And** users see appropriate error messages (NFR21, NFR27)

**Given** the free tier limits are approached
**When** monitoring usage
**Then** Vercel free tier: 100GB bandwidth, 100 deployments/month
**And** Supabase free tier: 500MB database, 2GB file storage, 2 Edge Functions
**And** Finnhub free tier: 60 API calls/minute
**And** for 10 users, these limits are sufficient
**And** upgrade paths are documented if scale increases

**Given** browser compatibility needs to be tested
**When** validating the app
**Then** tests are run on:

- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)
  **And** all features work correctly on these browsers (NFR23)
  **And** mobile optimization is deferred to V2 (NFR25)

**Given** responsive design is tested
**When** viewing on different screen sizes
**Then** the app works on:

- Desktop (1024px+) - primary target
- Tablet (768px+) - supported
  **And** mobile (<768px) may be awkward but functional (NFR25)
  **And** slide-over panels become full-screen on mobile (NFR24)

---

**Epic 6 Complete!**

---
