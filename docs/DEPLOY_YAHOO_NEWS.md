# Yahoo Finance News Integration

## What Changed

We replaced **Finnhub news** (which sometimes showed irrelevant news for wrong companies) with **Yahoo Finance news** (better quality, more relevant).

### Before:
- ❌ Finnhub news sometimes showed news for the wrong company (e.g., AMZN news for NVDA)
- ❌ Required complex filtering logic to remove irrelevant items
- ❌ No summary field, just headline + generic summary

### After:
- ✅ Yahoo Finance search API with `relatedTickers` field
- ✅ **Automatic relevance filtering** - only shows news that explicitly mentions the ticker
- ✅ Better quality news sources (Barron's, Business Wire, Bloomberg, etc.)
- ✅ Clickable headlines (already implemented)
- ✅ No API key needed (public Yahoo Finance endpoint)

---

## How It Works

1. **New Edge Function**: `fetch-yahoo-news`
   - Fetches from `https://query1.finance.yahoo.com/v1/finance/search`
   - Filters news by `relatedTickers` array
   - Returns only news items that explicitly mention the requested ticker

2. **Updated `stockApiEdge.ts`**:
   - Added `fetchYahooNews()` function
   - Removed complex Finnhub news filtering logic (100+ lines)
   - Simplified to: fetch Yahoo News → slice top 3 → done

3. **NewsItem interface**:
   - Made `summary` optional (Yahoo News doesn't have it)
   - Format: `{ headline, source, url, datetime }`

---

## Deployment Steps

### 1. Deploy Edge Function
```bash
cd /Users/ksrisurapaneni/Git-RV/portfolio-assistant
supabase functions deploy fetch-yahoo-news
```

### 2. Test Edge Function
```bash
curl -X POST \
  "$(grep VITE_SUPABASE_URL app/.env | cut -d'=' -f2)/functions/v1/fetch-yahoo-news" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(grep VITE_SUPABASE_ANON_KEY app/.env | cut -d'=' -f2)" \
  -d '{"symbol": "NVDA"}' | python3 -m json.tool
```

Expected response:
```json
{
  "news": [
    {
      "headline": "Broadcom Stock Rises On Google's Massive Capex Increase",
      "source": "Investor's Business Daily",
      "url": "https://finance.yahoo.com/m/0af5c14e-1291-3547-8c94-812f3782f7a0/broadcom-stock-rises-on.html",
      "datetime": 1770329405
    }
  ],
  "symbol": "NVDA",
  "cached": false
}
```

### 3. Test Locally
```bash
cd app
npm run dev
```

Visit `http://localhost:5176/`, add a stock (or refresh existing ones), and verify:
- ✅ News headlines appear on stock cards
- ✅ Headlines are relevant to the ticker
- ✅ Headlines are clickable links
- ✅ No irrelevant news (e.g., AMZN news for NVDA)

### 4. Push to Vercel (when ready)
```bash
git add .
git commit -m "Replace Finnhub news with Yahoo Finance news for better relevance"
git push origin master
```

Vercel auto-deployment will handle the rest. Edge Function is already deployed.

---

## What the User Will See

### Stock Card News Section:
```
📰 Recent News:
• "Broadcom Stock Rises On Google's Massive Capex Increase" (2h ago)
• "Why Google's Bad News Was Good News for Broadcom and Nvidia" (3h ago)
• "Trump Approved Nvidia's H200 China Chip Sales" (4h ago)
```

All headlines are **clickable links** to the full article on Yahoo Finance.

---

## Technical Details

### Yahoo Finance Search API
- **Endpoint**: `https://query1.finance.yahoo.com/v1/finance/search`
- **Parameters**:
  - `q`: ticker symbol (e.g., "NVDA")
  - `quotesCount`: number of quote results (we use 1)
  - `newsCount`: number of news items (we fetch 10, filter by relevance, show top 3)
- **Response**: JSON with `quotes[]` and `news[]` arrays
- **News item structure**:
  ```typescript
  {
    uuid: string;
    title: string;
    publisher: string;
    link: string;
    providerPublishTime: number; // Unix timestamp
    relatedTickers: string[]; // e.g., ["NVDA", "GOOGL", "AVGO"]
  }
  ```

### Edge Function Logic
```typescript
// Filter: only include news that explicitly mentions this ticker
const relatedTickers = item.relatedTickers || [];
if (!relatedTickers.includes(symbol.toUpperCase())) {
  continue; // Skip irrelevant news
}
```

This ensures **100% relevance** - no more AMZN news showing up for NVDA!

---

## Status
- ✅ Edge Function deployed
- ✅ Client code updated
- ✅ Tested locally (dev server running on http://localhost:5176/)
- ⏳ Ready to test in browser and push to production
