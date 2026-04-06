# Deploy Market Movers Feature

This guide explains how to deploy the Market Movers feature.

## Overview

The Market Movers tab displays Top Gainers and Top Losers from Yahoo Finance, showing the same stocks and numbers users see on Yahoo Finance's website.

## Prerequisites

**Supabase CLI** installed:

```bash
npm install -g supabase
```

**No API keys needed!** The Yahoo Finance screener endpoint is public and free.

## Deployment Steps

### 1. Deploy the Edge Function

From your project root:

```bash
# Login to Supabase
supabase login

# Link to your project (if not already linked)
supabase link --project-ref your-project-ref

# Deploy the function
supabase functions deploy scrape-market-movers
```

### 2. Test the Function

```bash
# Test gainers endpoint
curl -X POST \
  'https://your-project.supabase.co/functions/v1/scrape-market-movers' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer your-anon-key' \
  -d '{"type": "gainers"}'

# Test losers endpoint
curl -X POST \
  'https://your-project.supabase.co/functions/v1/scrape-market-movers' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer your-anon-key' \
  -d '{"type": "losers"}'
```

## What Changed

### New Files

- `supabase/functions/scrape-market-movers/index.ts` - Edge Function using Yahoo Finance screener API
- `app/src/components/MarketMovers.tsx` - UI component for displaying gainers/losers

### Modified Files

- `app/src/types/index.ts` - Added `'movers'` to `ActiveTab` type
- `app/src/App.tsx` - Added Market Movers tab with TrendingUp icon

## How It Works

**Data Source:** Yahoo Finance predefined screener API

- **Endpoint:** `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved`
- **Parameters:**
  - `scrIds`: `day_gainers` or `day_losers`
  - `count`: 25 (top 25 movers)
  - `formatted`: true (includes display formatting)

**Why This Works:**

- ✅ **Public API** - No authentication required
- ✅ **Accurate data** - Same source as Yahoo Finance website
- ✅ **Reliable** - Yahoo's official screener, not scraping HTML
- ✅ **Free** - No API key or rate limits

**Data Displayed:**

- Symbol (clickable → Yahoo Finance)
- Company Name
- Current Price
- Price Change ($)
- Price Change (%)

## UI Features

**Sticky Headers:**

- Table headers remain visible when scrolling
- Uses `sticky top-0 z-10` positioning

**Compact Tables:**

- Max height of 320px (`max-h-80`)
- Individual scrollbars for each table
- Top 25 gainers/losers displayed

**Visual Design:**

- Green theme for gainers
- Red theme for losers
- Hover effects on rows
- Clickable ticker symbols

## Troubleshooting

### No data showing

- Check browser console for errors
- Verify Supabase URL in `.env` file
- Test the Edge Function directly (see step 2)

### "Failed to fetch market movers" error

- Edge Function may not be deployed
- Check Supabase dashboard for function logs
- Verify CORS headers are configured

### Data looks wrong

- Data is pulled directly from Yahoo Finance
- If Yahoo shows different data, wait a few minutes and refresh
- Market data updates throughout the trading day

## Limitations

**Reliability:**

- Uses Yahoo Finance's unofficial screener API
- May break if Yahoo changes their API structure
- For personal projects only (not for commercial use)

**Data Freshness:**

- Updates based on Yahoo Finance's schedule
- Typically refreshes every few minutes during trading hours
- Data is from previous day's close when markets are closed

## Local Development

To test locally:

```bash
# Run Supabase functions locally
supabase functions serve scrape-market-movers

# Update your local .env
VITE_SUPABASE_URL=http://localhost:54321

# Start the app
cd app
npm run dev
```

## Production Notes

- **No API keys needed** - Yahoo Finance screener is public
- **No rate limits** - Reasonable usage is fine for personal projects
- **Graceful degradation** - If Yahoo changes their API, the tab shows an error message instead of breaking the entire app
- **Future-proofing** - Consider adding a fallback data source if Yahoo becomes unreliable
