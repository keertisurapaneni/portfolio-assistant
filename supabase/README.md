# Supabase Setup Guide

This folder contains database migrations and configuration for Portfolio Assistant's backend infrastructure.

## Quick Setup (5 minutes)

### Step 1: Create Supabase Project

1. Go to https://app.supabase.com
2. Click "New Project"
3. Fill in:
   - **Name:** `portfolio-assistant-prod` (or your preferred name)
   - **Database Password:** Generate a strong password (save it somewhere safe)
   - **Region:** Choose closest to your users (e.g., `US East (Ohio)` for US users)
   - **Pricing Plan:** Free tier is sufficient for MVP (500MB database, unlimited auth users)
4. Click "Create new project"
5. Wait ~2 minutes for project to provision

### Step 2: Get Your Project Credentials

Once the project is created:

1. Go to **Project Settings** (gear icon in sidebar)
2. Click **API** in the left menu
3. Copy these values:
   - **Project URL** (e.g., `https://abcdefghijk.supabase.co`)
   - **anon public** key (long string starting with `eyJ...`)
4. Update your `/app/.env` file:
   ```bash
   VITE_SUPABASE_URL=https://your-actual-project-url.supabase.co
   VITE_SUPABASE_ANON_KEY=your_actual_anon_key_here
   ```

### Step 3: Run Database Migrations

Two options: **SQL Editor (easiest)** or **Supabase CLI** (recommended for production).

#### Option A: SQL Editor (Quick & Easy)

1. In Supabase Dashboard, go to **SQL Editor** (</> icon in sidebar)
2. Click **New Query**
3. Copy contents of `migrations/20260205000001_initial_schema.sql`
4. Paste into editor and click **Run**
5. Create another new query
6. Copy contents of `migrations/20260205000002_rls_policies.sql`
7. Paste and click **Run**

✅ Done! Your database is set up.

#### Option B: Supabase CLI (Recommended)

```bash
# Install Supabase CLI (one-time)
npm install -g supabase

# Login to Supabase
supabase login

# Link your project
supabase link --project-ref your-project-ref

# Run migrations
supabase db push

# Verify migrations applied
supabase db diff
```

**Note:** Your `project-ref` is the part before `.supabase.co` in your project URL.

Example: If URL is `https://abcdefghijk.supabase.co`, project-ref is `abcdefghijk`.

### Step 4: Configure Authentication

Authentication is configured automatically by the migrations. Verify settings:

1. Go to **Authentication** → **Providers** in Supabase Dashboard
2. Confirm **Email** provider is enabled
3. Under **Auth Settings** → **Email Auth**:
   - ✅ Enable email provider
   - ❌ Disable "Confirm email" (for instant login in MVP)
   - Password policy: Minimum 8 characters
4. Under **Auth Settings** → **URL Configuration**:
   - **Site URL:** `http://localhost:5173` (local dev) or your Vercel domain (production)
   - **Redirect URLs:** Add your Vercel production URL when deployed

### Step 5: Verify Setup

Test database connectivity from your app:

```bash
# In /app directory
npm run dev
```

Open browser console (F12) and check for:

- No Supabase connection errors
- "Guest mode" should work immediately (localStorage)
- Auth features will work after implementing Stories 5.2-5.4

---

## Database Schema Overview

### Tables

**`portfolios`** - User portfolio holdings

- Stores ticker, shares, avg_cost, company_name
- One entry per user+ticker combination
- RLS enforced: users only see their own data

**`stock_cache`** - Shared API response cache

- Caches Finnhub API responses (15-min TTL)
- Reduces API calls for all users
- Managed by Edge Functions (service role)

**`user_dismissals`** - Dismissed stock suggestions

- Tracks which suggested stocks users have dismissed
- RLS enforced: users only see their own dismissals

### Row Level Security (RLS)

All tables have RLS enabled:

- **portfolios:** Users can only access their own portfolio data
- **user_dismissals:** Users can only access their own dismissals
- **stock_cache:** All authenticated users can read (shared cache), only Edge Functions can write

---

## Migrations

Migrations are located in `migrations/` folder and numbered sequentially:

1. `20260205000001_initial_schema.sql` - Create tables, indexes, triggers
2. `20260205000002_rls_policies.sql` - Enable RLS and create security policies

To add new migrations later:

```bash
supabase migration new your_migration_name
```

---

## Troubleshooting

**"relation auth.users does not exist"**

- Supabase Auth is not enabled. Go to Authentication in dashboard and enable it.

**"permission denied for table portfolios"**

- RLS policies not applied. Re-run `20260205000002_rls_policies.sql`.

**"Could not connect to Supabase"**

- Check `.env` file has correct `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
- Verify project is not paused (free tier auto-pauses after inactivity)

**"Password too short" during signup**

- Minimum password length is 8 characters (configured in migrations)

---

## Next Steps After Setup

Once Supabase is configured:

1. ✅ **Story 5.1 Complete** - Database is ready!
2. **Story 5.2:** Implement Storage Adapter Pattern (code changes)
3. **Story 5.3:** Implement Guest Mode UI
4. **Story 5.4:** Implement Auth UI (signup/login modals)
5. **Story 5.5:** Implement Guest-to-Auth Migration
6. **Story 5.6:** Implement Cloud Portfolio Sync

---

## Production Deployment Notes

When deploying to Vercel:

1. Add environment variables in **Vercel Dashboard** → **Settings** → **Environment Variables**:
   - `VITE_SUPABASE_URL` = your production Supabase URL
   - `VITE_SUPABASE_ANON_KEY` = your production anon key
2. Update **Site URL** in Supabase Auth settings to your Vercel domain
3. Add Vercel domain to **Redirect URLs** in Supabase Auth settings

---

## Maintenance

**Database Backups:**

- Supabase automatically backs up daily (free tier: 7-day retention)
- Manual backups: **Database** → **Backups** in dashboard

**Monitoring:**

- **Database** → **Query Performance** shows slow queries
- **Logs** → **Postgres Logs** for errors

**Scaling:**

- Free tier: 500MB database, 2 CPU cores
- Upgrade to Pro ($25/mo) for 8GB database, dedicated resources
