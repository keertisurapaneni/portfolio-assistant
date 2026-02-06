# Deployment & Operations

## Environment Setup

**Required Environment Variables:**

```bash
# Frontend (.env for local, Vercel dashboard for production)
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJxxx...

# Edge Functions (Supabase secrets)
FINNHUB_API_KEY=d621d1pr01qgcobr8bggd621d1pr01qgcobr8bh0
```

**Setting Secrets (Supabase):**
```bash
# Set Edge Function secret
supabase secrets set FINNHUB_API_KEY=d621d1pr01qgcobr8bggd621d1pr01qgcobr8bh0

# List secrets
supabase secrets list
```

**Setting Environment Variables (Vercel):**
- Dashboard → Project → Settings → Environment Variables
- Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
- Available in: Production, Preview, Development

---

## Deployment Process

**1. Supabase Setup:**

```bash
# Link to Supabase project
supabase link --project-ref xxx

# Run migrations
supabase db push

# Deploy Edge Functions
supabase functions deploy fetch-stock-data

# Set secrets
supabase secrets set FINNHUB_API_KEY=xxx
```

**2. Vercel Deployment:**

```bash
# Install Vercel CLI (optional)
npm i -g vercel

# Deploy (or use Git push for automatic deployment)
vercel --prod
```

**Automatic Deployment (Git):**
- Connect Vercel to GitHub repository
- Every push to `main` → automatic production deployment
- Every PR → automatic preview deployment

---

## Monitoring & Observability

**Supabase Dashboard:**
- Database performance: Query insights, slow queries
- Edge Functions: Logs, invocation count, errors
- Auth: User signups, login attempts
- Storage: Database size, table sizes

**Vercel Analytics:**
- Page views, unique visitors
- Core Web Vitals (LCP, FID, CLS)
- Deployment history, build logs

**Finnhub Monitoring:**
- API call count (manual check)
- Rate limit status (via error responses)

**Error Tracking:**
- Console errors in browser DevTools
- Supabase Edge Function logs
- Vercel Function logs

---

## Backup & Recovery

**Database Backup:**
- Supabase automatic daily backups (retained 7 days on free tier)
- Manual backup: `supabase db dump > backup.sql`
- Restore: `supabase db reset` then run SQL file

**Code Backup:**
- Git repository (GitHub) is source of truth
- All code version controlled

**Data Export (User-facing):**
- Users can export portfolio as JSON (localStorage or DB)
- Export button in UI (V2 roadmap)

---

## Scaling Considerations

**Current Limits (Free Tiers):**
- Supabase: 500MB DB, 50K MAU, 2GB Edge Function invocations/month
- Vercel: 100GB bandwidth, 100GB-hours compute
- Finnhub: 60 calls/min

**When to Upgrade:**
- **Database:** > 400MB usage (monitor via Supabase dashboard)
- **Users:** > 10 active users (constraint by design, no upgrade needed)
- **API:** > 50 calls/min sustained (upgrade Finnhub or add rate limiting)

**Upgrade Path:**
- Supabase Pro: $25/month (8GB DB, 100K MAU)
- Vercel Pro: $20/month (1TB bandwidth)
- Finnhub: $60/month (300 calls/min)

---

## Maintenance Tasks

**Weekly:**
- [ ] Check Supabase database size
- [ ] Review Edge Function error logs
- [ ] Monitor Finnhub API usage

**Monthly:**
- [ ] Review dependency updates (`npm outdated`)
- [ ] Apply security patches
- [ ] Review Vercel analytics

**Quarterly:**
- [ ] Database cleanup (if needed)
- [ ] Review and archive old logs
- [ ] Evaluate new features from providers

---

## Rollback Procedures

**Frontend Rollback (Vercel):**
- Dashboard → Deployments → Select previous deployment → Promote to Production

**Database Rollback (Supabase):**
- Restore from automatic backup (max 7 days)
- Or run migration rollback script (if reversible)

**Edge Function Rollback:**
- Redeploy previous version: `supabase functions deploy fetch-stock-data`

---

**Deployment Status:** ✅ Complete and operational

---
