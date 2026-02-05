# Supabase Edge Functions

This folder contains Supabase Edge Functions (serverless Deno functions) for Portfolio Assistant.

## Functions

### `fetch-stock-data`

Secure proxy for Finnhub API calls with server-side caching.

**Purpose:**

- Protect Finnhub API key (never exposed to client)
- Server-side caching (15 minutes TTL) to reduce API calls
- Graceful fallback to stale cache on errors
- Rate limit protection

**Endpoints:**

- `quote` - Current price, change, high/low
- `metrics` - Fundamentals (P/E, margins, ROE, beta, 52-week range)
- `recommendations` - Analyst consensus (Strong Buy, Buy, Hold, Sell, Strong Sell)
- `earnings` - Quarterly earnings history (actual vs estimate)

**Request:**

```json
POST https://<project-ref>.supabase.co/functions/v1/fetch-stock-data
Headers:
  Content-Type: application/json
  Authorization: Bearer <supabase-anon-key>
  apikey: <supabase-anon-key>
Body:
{
  "ticker": "AAPL",
  "endpoint": "quote"
}
```

**Response (Success):**

```json
{
  "c": 150.25,
  "d": 2.5,
  "dp": 1.69,
  "h": 151.0,
  "l": 148.5,
  "o": 149.0,
  "pc": 147.75,
  "cached": false
}
```

**Response (Cached):**

```json
{
  ... data ...,
  "cached": true,
  "cacheAge": 450
}
```

**Response (Error with stale cache):**

```json
{
  ... stale data ...,
  "cached": true,
  "stale": true,
  "error": "Rate limit exceeded. Using cached data."
}
```

## Deployment

### Prerequisites

- Supabase CLI installed: `brew install supabase/tap/supabase`
- Logged in: `supabase login`
- Project linked: `supabase link --project-ref <your-project-ref>`
- Docker/Colima running

### Set Secrets

```bash
supabase secrets set FINNHUB_API_KEY=your_actual_key_here
```

### Deploy

```bash
cd supabase
supabase functions deploy fetch-stock-data
```

### Test Locally

```bash
supabase functions serve fetch-stock-data
```

Then test with:

```bash
curl -X POST http://localhost:54321/functions/v1/fetch-stock-data \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <anon-key>" \
  -d '{"ticker":"AAPL","endpoint":"quote"}'
```

## Security

- **API Key**: Stored as Edge Function secret (never in code)
- **RLS**: Cache table allows authenticated users to read, service_role to write
- **CORS**: Currently allows all origins (`*`) - restrict to your domain in production
- **Rate Limiting**: Client-side throttling + Finnhub rate limits

## Monitoring

Check logs in Supabase Dashboard:

- **Project** → **Edge Functions** → `fetch-stock-data` → **Logs**

Look for:

- `[Cache HIT]` - Data served from cache
- `[Cache STALE]` - Cache expired, fetching fresh data
- `[Finnhub API]` - Actual API call made
- `[Cache UPDATED]` - New data cached
- `[Fallback]` - Error occurred, returning stale cache

## Troubleshooting

**Error: `FINNHUB_API_KEY not configured`**

- Run: `supabase secrets set FINNHUB_API_KEY=your_key`

**Error: `Import failed: 524`**

- Change import from `esm.sh` to `jsr:` registry

**Error: `Database error: relation "stock_cache" does not exist`**

- Ensure migrations ran: `supabase db push`

**Slow responses on first deploy:**

- Cold start (image pull) - subsequent calls are fast

**Cache not working:**

- Check `stock_cache` table has data: `select * from stock_cache;`
- Verify RLS policies allow service_role to write
