# Integration Points & API Contracts

## Frontend ↔ Supabase Edge Function

**Endpoint:** `fetch-stock-data`

**Request:**
```typescript
// Method: POST via supabase.functions.invoke()
{
  ticker: string  // e.g., "AAPL"
}
```

**Success Response (200):**
```typescript
{
  ticker: string,
  name: string,
  currentPrice: number,
  qualityScore: number,      // 0-100
  momentumScore: number,      // 0-100
  earningsScore: number,      // 0-100
  analystScore: number,       // 0-100
  analystRating: {
    buy: number,
    hold: number,
    sell: number,
    strongBuy: number,
    strongSell: number
  } | null,
  quarterlyEPS: Array<{
    date: string,         // ISO 8601
    actual: number,
    estimate: number
  }>
}
```

**Error Response (4xx/5xx):**
```typescript
{
  error: string,        // Human-readable message
  code: string,         // Machine-readable code
  details?: any         // Optional additional context
}

// Common error codes:
// - INVALID_TICKER: Ticker not found
// - RATE_LIMIT_EXCEEDED: Finnhub rate limit hit
// - API_ERROR: Finnhub API error
// - CACHE_ERROR: Database cache error
```

**Example Usage:**
```typescript
const { data, error } = await supabase.functions.invoke('fetch-stock-data', {
  body: { ticker: 'AAPL' }
});

if (error) {
  console.error('Failed to fetch stock data:', error);
  return;
}

console.log('Stock data:', data);
```

---

## Edge Function ↔ Finnhub API

**Quote Endpoint:**
```
GET https://finnhub.io/api/v1/quote
Query params: symbol={ticker}&token={API_KEY}
Response: { c: current_price, ... }
```

**Metrics Endpoint:**
```
GET https://finnhub.io/api/v1/stock/metric
Query params: symbol={ticker}&metric=all&token={API_KEY}
Response: { metric: { roic, margin, ... } }
```

**Recommendations Endpoint:**
```
GET https://finnhub.io/api/v1/stock/recommendation
Query params: symbol={ticker}&token={API_KEY}
Response: [{ buy, hold, sell, ... }]
```

**Earnings Endpoint:**
```
GET https://finnhub.io/api/v1/stock/earnings
Query params: symbol={ticker}&token={API_KEY}
Response: [{ actual, estimate, period, ... }]
```

**Rate Limits:**
- Free tier: 60 calls/minute
- Strategy: Cache for 15 minutes, batch requests

---

## Frontend ↔ Supabase Auth

**Login:**
```typescript
const { data, error } = await supabase.auth.signInWithPassword({
  email: string,
  password: string
});
```

**Signup:**
```typescript
const { data, error } = await supabase.auth.signUp({
  email: string,
  password: string
});
```

**Get Session:**
```typescript
const { data: { session } } = await supabase.auth.getSession();
```

**Logout:**
```typescript
const { error } = await supabase.auth.signOut();
```

---

## Frontend ↔ Supabase Database

**Storage Adapter Interface:**

```typescript
interface StorageAdapter {
  // Get all stocks for current user
  getStocks(): Promise<Stock[]>;
  
  // Add a stock
  addStock(stock: Omit<Stock, 'id' | 'dateAdded'>): Promise<Stock>;
  
  // Update a stock
  updateStock(ticker: string, updates: Partial<Stock>): Promise<Stock>;
  
  // Remove a stock
  removeStock(ticker: string): Promise<boolean>;
  
  // Clear all stocks
  clearAll(): Promise<void>;
}
```

**LocalStorage Implementation (Guest Mode):**
```typescript
class LocalStorageAdapter implements StorageAdapter {
  private readonly STORAGE_KEY = 'portfolio-assistant-data';
  
  getStocks(): Promise<Stock[]> {
    const data = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{"stocks":[]}');
    return Promise.resolve(data.stocks);
  }
  
  // ... other methods
}
```

**Supabase Implementation (Auth Mode):**
```typescript
class SupabaseStorageAdapter implements StorageAdapter {
  constructor(private supabase: SupabaseClient) {}
  
  async getStocks(): Promise<Stock[]> {
    const { data, error } = await this.supabase
      .from('stocks')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    return data || [];
  }
  
  // ... other methods with RLS automatic filtering by user_id
}
```

---

## Database Schema Contracts

**Table: `stocks`**

```sql
CREATE TABLE stocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  name TEXT,
  shares NUMERIC(20, 8),
  avg_cost NUMERIC(20, 8),
  current_price NUMERIC(20, 8),
  quality_score INTEGER CHECK (quality_score >= 0 AND quality_score <= 100),
  momentum_score INTEGER CHECK (momentum_score >= 0 AND momentum_score <= 100),
  earnings_score INTEGER CHECK (earnings_score >= 0 AND earnings_score <= 100),
  analyst_score INTEGER CHECK (analyst_score >= 0 AND analyst_score <= 100),
  analyst_rating JSONB,
  quarterly_eps JSONB,
  date_added TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT stocks_user_ticker_unique UNIQUE(user_id, ticker)
);
```

**RLS Policy:**
```sql
-- Users can only see/modify their own stocks
CREATE POLICY "Users manage own stocks"
  ON stocks
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

**Table: `stock_cache`**

```sql
CREATE TABLE stock_cache (
  ticker TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- No RLS - shared cache across all users
```

---

## Error Handling Contracts

**Frontend Error Handling:**

```typescript
// Always use try-catch for async operations
try {
  const data = await getStockData(ticker);
  // Success path
} catch (error) {
  if (error.code === 'RATE_LIMIT_EXCEEDED') {
    // Show rate limit message
  } else if (error.code === 'INVALID_TICKER') {
    // Show invalid ticker message
  } else {
    // Show generic error message
  }
}
```

**Edge Function Error Handling:**

```typescript
// Always return consistent error format
return new Response(
  JSON.stringify({ 
    error: 'Human-readable message',
    code: 'MACHINE_READABLE_CODE',
    details: { /* optional */ }
  }), 
  { 
    status: 400, // or 500
    headers: { 'Content-Type': 'application/json' }
  }
);
```

---

## Caching Contract

**Cache Key Format:**
- Stock cache: `ticker` (e.g., `"AAPL"`)

**Cache TTL:**
- Stock data: 15 minutes

**Cache Invalidation:**
- Automatic: TTL expiration (Edge Function checks `cached_at`)
- Manual: None needed (TTL handles freshness)

**Cache Hit Logic:**
```typescript
// Edge Function
const { data: cached } = await supabase
  .from('stock_cache')
  .select('*')
  .eq('ticker', ticker)
  .single();

if (cached && isWithinTTL(cached.cached_at, 15)) {
  return cached.data; // Cache hit
}

// Cache miss - fetch from Finnhub
```

---

**Integration Status:** ✅ Complete and documented

---
