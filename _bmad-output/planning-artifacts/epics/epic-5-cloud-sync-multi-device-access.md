# Epic 5: Cloud Sync & Multi-Device Access

Users can access their portfolio from any device via optional email/password authentication with seamless guest-to-auth migration.

## Story 5.1: Supabase Project Setup & Database Schema

As a system administrator,
I want a Supabase project with database schema and security policies,
So that authenticated users can securely store and sync their portfolio data in the cloud.

**Acceptance Criteria:**

**Given** Supabase project does not exist
**When** setting up the backend infrastructure
**Then** a new Supabase project is created with a descriptive name (e.g., "portfolio-assistant-prod")
**And** the project is in a region close to primary users (e.g., US East)
**And** project URL and anon key are noted for frontend configuration

**Given** database schema needs to be created
**When** running initial migrations
**Then** the following tables are created:

**Table: `portfolios`**

- `id` (uuid, primary key, default: uuid_generate_v4())
- `user_id` (uuid, references auth.users, not null)
- `ticker` (text, not null)
- `shares` (numeric, nullable)
- `avg_cost` (numeric, nullable)
- `company_name` (text, nullable)
- `added_at` (timestamp, default: now())
- `updated_at` (timestamp, default: now())
- Composite unique constraint: `(user_id, ticker)`
- Index on `user_id` for fast queries

**Table: `stock_cache`**

- `ticker` (text, not null)
- `endpoint` (text, not null, enum: 'quote', 'metrics', 'recommendations', 'earnings')
- `data` (jsonb, not null)
- `cached_at` (timestamp, default: now())
- Primary key: `(ticker, endpoint)`
- Index on `cached_at` for TTL checks

**Table: `user_dismissals`**

- `id` (uuid, primary key, default: uuid_generate_v4())
- `user_id` (uuid, references auth.users, not null)
- `ticker` (text, not null)
- `archetype` (text, not null)
- `dismissed_at` (timestamp, default: now())
- Composite unique constraint: `(user_id, ticker, archetype)`
- Index on `user_id`

**Given** Row Level Security (RLS) needs to be enforced
**When** security policies are created
**Then** RLS is enabled on `portfolios` table with policies:

- SELECT: `user_id = auth.uid()` (users see only their own data)
- INSERT: `user_id = auth.uid()` (users can only insert their own data)
- UPDATE: `user_id = auth.uid()` (users can only update their own data)
- DELETE: `user_id = auth.uid()` (users can only delete their own data)

**And** RLS is enabled on `user_dismissals` table with similar policies:

- SELECT: `user_id = auth.uid()`
- INSERT: `user_id = auth.uid()`
- DELETE: `user_id = auth.uid()`

**And** `stock_cache` table has read-only RLS:

- SELECT: `true` (all authenticated users can read cache)
- INSERT/UPDATE/DELETE: restricted to service role only (Edge Function)

**Given** Supabase Auth is configured
**When** setting up authentication
**Then** email/password provider is enabled
**And** email confirmations are disabled for MVP (instant login after signup)
**And** password requirements: minimum 8 characters
**And** magic links and OAuth providers are disabled

**Given** database is deployed
**When** testing connectivity
**Then** frontend can connect using Supabase client with anon key
**And** RLS policies correctly restrict access to user's own data
**And** unauthenticated requests are rejected for protected tables

---

## Story 5.2: Storage Adapter Pattern

As a developer,
I want a storage adapter interface that abstracts localStorage and Supabase implementations,
So that the app can seamlessly switch between guest and authenticated storage without changing business logic.

**Acceptance Criteria:**

**Given** the app needs to support hybrid storage
**When** the storage layer is designed
**Then** a `StorageAdapter` interface is defined with methods:

- `getPortfolio(): Promise<Stock[]>`
- `savePortfolio(stocks: Stock[]): Promise<void>`
- `addStock(stock: Stock): Promise<void>`
- `removeStock(ticker: string): Promise<void>`
- `clearPortfolio(): Promise<void>`
- `getDismissals(): Promise<Dismissal[]>`
- `saveDismissal(ticker: string, archetype: string): Promise<void>`

**Given** guest mode storage is needed
**When** implementing `LocalStorageAdapter`
**Then** it implements all `StorageAdapter` methods using browser localStorage
**And** portfolio data is stored in key: `portfolio-assistant-data`
**And** dismissals are stored in key: `portfolio-assistant-dismissals`
**And** all operations are synchronous but wrapped in promises for interface consistency
**And** localStorage is never accessed directly outside this adapter

**Given** authenticated mode storage is needed
**When** implementing `SupabaseStorageAdapter`
**Then** it implements all `StorageAdapter` methods using Supabase client
**And** portfolio methods query/mutate the `portfolios` table
**And** dismissal methods query/mutate the `user_dismissals` table
**And** all operations handle Supabase errors gracefully
**And** RLS policies are enforced automatically

**Given** the app is initialized
**When** determining which adapter to use
**Then** a `StorageManager` checks if user is authenticated (via Supabase Auth)
**And** if authenticated: returns `SupabaseStorageAdapter` instance
**And** if guest: returns `LocalStorageAdapter` instance
**And** the active adapter is cached and reused throughout the session

**Given** business logic needs to access storage
**When** components fetch or update portfolio data
**Then** they call `StorageManager.getAdapter()` to get the current adapter
**And** they use adapter methods without knowing the underlying implementation
**And** switching from guest to auth requires only changing the adapter instance

**Given** errors occur during Supabase operations
**When** a network failure or database error happens
**Then** the adapter returns a rejected promise with a user-friendly error message
**And** the UI handles the error gracefully (shows toast, allows retry)
**And** guest users never see Supabase-related errors

**Given** the adapter pattern is implemented
**When** running tests
**Then** a `MockStorageAdapter` can be created for unit testing
**And** business logic is decoupled from storage implementation
**And** future storage backends (e.g., Firebase) can be added by implementing the interface

---

## Story 5.3: Guest Mode Experience

As a new user,
I want to use Portfolio Assistant without creating an account,
So that I can evaluate the product before committing to signup.

**Acceptance Criteria:**

**Given** I visit Portfolio Assistant for the first time
**When** the app loads
**Then** I am in guest mode by default (no login required)
**And** I see a guest mode banner at the top: "You're using Portfolio Assistant as a guest. Your data is saved in this browser only."
**And** the banner includes a "Sign Up" button styled as a primary action

**Given** I am in guest mode
**When** I use portfolio features (add stocks, view scores, etc.)
**Then** all functionality works exactly as it would for authenticated users
**And** data is saved to localStorage automatically
**And** there are no feature limitations or nag screens

**Given** I am in guest mode and refresh the browser
**When** the page reloads
**Then** my portfolio data persists from localStorage
**And** I remain in guest mode
**And** the guest banner is still visible

**Given** I am in guest mode and close the browser
**When** I return to the site days later (same browser/device)
**Then** my portfolio data is still available
**And** localStorage persists indefinitely (until browser cache is cleared)

**Given** I am in guest mode and clear my browser data
**When** localStorage is cleared
**Then** my portfolio is lost (expected behavior)
**And** the app gracefully handles empty localStorage
**And** I see the empty portfolio state: "Your portfolio is empty. Add stocks to get started."

**Given** I am in guest mode on Device A
**When** I open Portfolio Assistant on Device B
**Then** I see an empty portfolio on Device B (localStorage is device-specific)
**And** Device A's data is unaffected
**And** the guest banner appears on both devices

**Given** I am in guest mode and click "Sign Up" in the banner
**When** the signup button is clicked
**Then** the signup modal opens (Story 5.4)
**And** I am prompted to create an account
**And** after signup, my guest data is migrated to the cloud (Story 5.5)

---

## Story 5.4: User Registration & Login

As a user,
I want to create an account with email and password,
So that I can sync my portfolio across devices and access it from anywhere.

**Acceptance Criteria:**

**Given** I am in guest mode
**When** I click "Sign Up" in the guest banner or header
**Then** a signup modal opens with fields:

- Email (text input, required)
- Password (password input, required, min 8 characters)
- Confirm Password (password input, required, must match)
- "Create Account" button
- Link to login: "Already have an account? Log in"
  **And** the modal has a close (X) button

**Given** I enter valid email and matching passwords
**When** I click "Create Account"
**Then** Supabase Auth creates a new user account
**And** I am automatically logged in
**And** the modal closes
**And** my guest portfolio is migrated to the cloud (Story 5.5)
**And** I see a success toast: "Account created! Your portfolio has been synced to the cloud."
**And** the guest banner is replaced with an account menu (Story 5.7)

**Given** I enter an email that already exists
**When** I click "Create Account"
**Then** I see an error message: "This email is already registered. Please log in instead."
**And** the modal remains open
**And** no account is created

**Given** I enter passwords that don't match
**When** I click "Create Account"
**Then** I see an error message: "Passwords do not match"
**And** the "Confirm Password" field is highlighted in red
**And** the modal remains open

**Given** I enter a password < 8 characters
**When** I click "Create Account"
**Then** I see an error message: "Password must be at least 8 characters"
**And** the form does not submit

**Given** I am on the signup modal
**When** I click "Already have an account? Log in"
**Then** the signup modal closes
**And** the login modal opens immediately (seamless transition)

**Given** I want to log in with an existing account
**When** I open the login modal
**Then** I see fields:

- Email (text input, required)
- Password (password input, required)
- "Log In" button
- Link to signup: "Don't have an account? Sign up"
  **And** the modal has a close (X) button

**Given** I enter valid credentials in the login modal
**When** I click "Log In"
**Then** Supabase Auth authenticates me
**And** the modal closes
**And** my cloud portfolio is loaded from Supabase (Story 5.6)
**And** I see a success toast: "Welcome back!"
**And** the guest banner is replaced with an account menu (Story 5.7)

**Given** I enter invalid credentials (wrong password or email not found)
**When** I click "Log In"
**Then** I see an error message: "Invalid email or password"
**And** the modal remains open
**And** I can retry

**Given** I am on the login modal
**When** I click "Don't have an account? Sign up"
**Then** the login modal closes
**And** the signup modal opens immediately

**Given** network errors occur during signup/login
**When** Supabase API calls fail
**Then** I see an error message: "Connection error. Please try again."
**And** the modal remains open for retry
**And** my data remains safe (no partial state)

---

## Story 5.5: Guest-to-Auth Migration

As a guest user who signs up,
I want my existing portfolio to be automatically transferred to my new account,
So that I don't lose any work I've done before creating an account.

**Acceptance Criteria:**

**Given** I have stocks in my portfolio as a guest
**When** I complete signup (Story 5.4)
**Then** the system detects non-empty localStorage portfolio
**And** triggers automatic migration to Supabase

**Given** migration is triggered
**When** processing guest data
**Then** the system reads all stocks from localStorage (via `LocalStorageAdapter`)
**And** inserts each stock into the `portfolios` table with `user_id` = my new auth user ID
**And** handles duplicates gracefully (if ticker already exists in cloud, skip)

**Given** I have 10 stocks in my guest portfolio
**When** migration runs
**Then** all 10 stocks are inserted into Supabase
**And** the migration completes within 2-3 seconds
**And** I see a loading indicator: "Syncing your portfolio to the cloud..."

**Given** migration completes successfully
**When** the process finishes
**Then** localStorage portfolio is optionally cleared (or marked as migrated)
**And** the app switches to `SupabaseStorageAdapter`
**And** I see all my stocks in the Portfolio tab
**And** a success toast appears: "Your portfolio has been synced! Access it from any device."

**Given** migration encounters errors (network failure, rate limit)
**When** the error occurs
**Then** localStorage data is NOT cleared (safety first)
**And** I see an error message: "Failed to sync portfolio to cloud. Your data is safe in this browser. Try logging in again to retry."
**And** my guest data remains intact for manual retry

**Given** I have dismissed suggestions as a guest
**When** migration runs
**Then** dismissed suggestions are also migrated to `user_dismissals` table
**And** dismissed stocks remain hidden after migration
**And** dismissal state is consistent across devices after migration

**Given** I sign up with a completely empty portfolio
**When** migration runs
**Then** no data is inserted into Supabase (no-op)
**And** the migration completes instantly
**And** I start with an empty cloud portfolio

**Given** I log in on a second device after migrating
**When** the app loads
**Then** I see my migrated portfolio on the second device
**And** all stocks, scores, and dismissals are present
**And** changes on Device A sync to Device B (and vice versa)

**Given** I manually log out and log back in on the same device
**When** I re-authenticate
**Then** the system does NOT re-migrate localStorage data
**And** cloud data takes precedence (no duplicates)
**And** localStorage may still contain old guest data but is ignored

---

## Story 5.6: Cloud Portfolio Sync

As an authenticated user,
I want my portfolio changes to automatically sync to the cloud,
So that I can access my portfolio from any device and never lose my data.

**Acceptance Criteria:**

**Given** I am logged in as an authenticated user
**When** I add a stock to my portfolio
**Then** the stock is immediately inserted into the Supabase `portfolios` table
**And** the INSERT happens via `SupabaseStorageAdapter.addStock()`
**And** RLS policy ensures the stock is linked to my `user_id`

**Given** I am logged in as an authenticated user
**When** I remove a stock from my portfolio
**Then** the stock is immediately deleted from the Supabase `portfolios` table
**And** the DELETE happens via `SupabaseStorageAdapter.removeStock()`
**And** the stock is removed only for my `user_id` (other users' data unaffected)

**Given** I am logged in as an authenticated user
**When** I clear my entire portfolio
**Then** all my stocks are deleted from Supabase (via DELETE WHERE user_id = auth.uid())
**And** other users' portfolios remain unaffected
**And** the operation completes within 1 second

**Given** I am logged in on Device A
**When** I add a stock on Device A
**Then** the stock is saved to Supabase
**And** when I open Portfolio Assistant on Device B
**And** I log in on Device B
**Then** I see the stock added from Device A

**Given** I am logged in on both Device A and Device B simultaneously
**When** I add a stock on Device A
**Then** Device B does NOT automatically refresh (real-time sync is V2)
**And** Device B sees the new stock after manually refreshing the page
**And** this behavior is acceptable for MVP with 10 users

**Given** I lose network connectivity while authenticated
**When** I attempt to add or remove stocks
**Then** the operation fails with an error: "Connection error. Changes not saved. Please try again when online."
**And** the UI shows a warning banner: "You're offline. Changes won't sync until you're back online."
**And** localStorage is NOT used as a fallback (cloud users expect cloud consistency)

**Given** Supabase connection fails temporarily
**When** I perform portfolio operations
**Then** errors are displayed clearly: "Failed to sync. Please try again."
**And** a "Retry" button allows immediate retry
**And** I am NOT automatically logged out (auth session persists)

**Given** I am logged in and viewing my portfolio
**When** the page loads
**Then** the app fetches my portfolio from Supabase using `SELECT * FROM portfolios WHERE user_id = auth.uid()`
**And** the query completes within 1-2 seconds
**And** stocks are displayed in the Portfolio tab
**And** localStorage is NOT read (cloud data is source of truth)

**Given** I am logged in and import a CSV file
**When** the import completes (Story 1.4)
**Then** all imported stocks are inserted into Supabase in a batch operation
**And** the batch insert completes within 2-3 seconds for 50 stocks
**And** duplicate tickers are handled by ON CONFLICT DO NOTHING or UPDATE

**Given** I dismiss a suggestion while logged in
**When** the dismissal occurs
**Then** the dismissal is saved to `user_dismissals` table with my `user_id`
**And** dismissed suggestions remain hidden across all my devices
**And** dismissals sync just like portfolio data

---

## Story 5.7: Account Management UI

As a user,
I want clear visual indicators of my auth status and easy access to login/logout,
So that I always know if my data is syncing to the cloud and can manage my account.

**Acceptance Criteria:**

**Given** I am in guest mode
**When** viewing the app header
**Then** I see a guest mode banner at the top of the page
**And** the banner displays: "You're using Portfolio Assistant as a guest. Your data is saved in this browser only."
**And** the banner includes a "Sign Up" button (primary style, green or blue)
**And** the banner is visually distinct but not intrusive (e.g., light yellow background, info icon)

**Given** I am in guest mode
**When** viewing the app header navigation
**Then** I see a "Log In" link in the top-right corner
**And** clicking it opens the login modal (Story 5.4)

**Given** I am logged in as an authenticated user
**When** viewing the app header
**Then** the guest banner is NOT visible
**And** I see an account menu in the top-right corner
**And** the menu shows my email address or first part of email (e.g., "user@example.com" or "user")

**Given** I am logged in
**When** I click on the account menu
**Then** a dropdown appears with options:

- Email address (non-clickable, displayed at top for context)
- "Log Out" button (clickable)
  **And** the dropdown is styled consistently with the app theme

**Given** I am logged in and click "Log Out"
**When** the logout action is triggered
**Then** Supabase Auth signs me out
**And** the app switches to guest mode
**And** the guest banner reappears
**And** my localStorage is cleared (or marked as inactive)
**And** I see an empty portfolio (logged-out state)
**And** a toast notification appears: "You've been logged out. Your cloud data is safe."

**Given** I log out and then log back in
**When** I authenticate again
**Then** my cloud portfolio is loaded from Supabase
**And** I see all my stocks exactly as I left them
**And** the account menu reappears with my email

**Given** my auth session expires (after 7 days or 30 days depending on "Remember Me")
**When** I return to the app
**Then** I am automatically logged out
**And** I see the guest mode experience
**And** a toast notification: "Session expired. Please log in again."

**Given** I am logged in on multiple tabs
**When** I log out in Tab A
**Then** Tab B detects the session change (via Supabase Auth listener)
**And** Tab B also shows the logged-out state
**And** this provides consistent experience across tabs

**Given** I am in guest mode and have stocks in localStorage
**When** I log in (not signup) with an existing account
**Then** the app asks: "You have {N} stocks in your browser. Would you like to merge them with your cloud portfolio?"
**And** options are: "Merge", "Discard Local Data", "Cancel"
**And** selecting "Merge" triggers migration to cloud (Story 5.5)
**And** selecting "Discard" clears localStorage and loads cloud data only

**Given** I am viewing auth-related modals (login/signup)
**When** I press the Escape key
**Then** the modal closes
**And** I return to the previous view (guest or authenticated)

**Given** I am on a tablet or mobile device
**When** viewing the auth UI
**Then** modals are responsive and readable
**And** forms are easy to complete on touch devices
**And** the guest banner adapts to smaller screens (text may wrap or abbreviate)

---
