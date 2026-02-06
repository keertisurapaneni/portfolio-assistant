# Implementation Patterns & Consistency Rules

## Purpose

This section defines conventions that AI agents and developers must follow to ensure consistency across the codebase. These patterns prevent conflicts when multiple agents or team members work on different features.

---

## Naming Patterns

**Database (Supabase PostgreSQL):**
- Tables: `snake_case` (e.g., `stocks`, `stock_cache`, `user_profiles`)
- Columns: `snake_case` (e.g., `ticker`, `created_at`, `cached_at`)
- Foreign Keys: `{table}_id` (e.g., `user_id`, `portfolio_id`)
- Indexes: `idx_{table}_{column}` (e.g., `idx_stocks_user_id`)
- Constraints: `{table}_{column}_{type}` (e.g., `stocks_ticker_unique`)

**API & Edge Functions:**
- Edge Function names: `kebab-case` (e.g., `fetch-stock-data`, `sync-portfolio`)
- Request/Response fields: `camelCase` (e.g., `{ ticker: "AAPL", currentPrice: 150.25 }`)
- Error codes: `SCREAMING_SNAKE_CASE` (e.g., `RATE_LIMIT_EXCEEDED`, `INVALID_TICKER`)

**Code (TypeScript/React):**
- Components: `PascalCase` (e.g., `Dashboard`, `StockDetail`, `AddTickersModal`)
- Files: `camelCase` (e.g., `convictionEngine.ts`, `stockApi.ts`, `storage.ts`)
- Functions: `camelCase` (e.g., `getConvictionResult`, `fetchStockData`)
- Variables: `camelCase` (e.g., `currentPrice`, `analystScore`)
- Constants: `SCREAMING_SNAKE_CASE` (e.g., `API_BASE_URL`, `CACHE_TTL_MINUTES`)
- Types/Interfaces: `PascalCase` (e.g., `Stock`, `ConvictionResult`, `StockWithConviction`)

---

## Structure Patterns

**Component Organization:**
```
src/
├── components/
│   ├── features/          # Feature-specific components
│   │   ├── Dashboard.tsx
│   │   ├── StockDetail.tsx
│   │   └── SuggestedFinds.tsx
│   ├── shared/            # Reusable UI components
│   │   ├── Button.tsx
│   │   └── Modal.tsx
│   └── layout/            # Layout components
│       ├── Header.tsx
│       └── Footer.tsx
├── lib/
│   ├── api/               # API clients and wrappers
│   │   ├── stockApi.ts
│   │   └── supabaseClient.ts
│   ├── engines/           # Business logic
│   │   ├── convictionEngine.ts
│   │   └── portfolioCalc.ts
│   └── utils/             # Utilities
│       ├── storage.ts
│       └── formatters.ts
├── types/
│   └── index.ts           # All TypeScript types
└── App.tsx
```

**Test Co-location:**
- Unit tests: `{filename}.test.ts` (e.g., `convictionEngine.test.ts`)
- Place tests adjacent to the code they test
- Integration tests: `/tests/integration/{feature}.test.ts`

---

## Format Patterns

**API Responses:**
- **Success:** Direct data response (no wrapper object)
  ```typescript
  // ✓ Correct
  { ticker: "AAPL", currentPrice: 150.25, qualityScore: 75 }
  
  // ✗ Wrong
  { success: true, data: { ticker: "AAPL", ... } }
  ```

- **Errors:** Consistent error object
  ```typescript
  { error: string, code: string, details?: any }
  // Example: { error: "Rate limit exceeded", code: "RATE_LIMIT_EXCEEDED" }
  ```

**JSON Field Conventions:**
- Use `camelCase` for all JSON fields (not `snake_case`)
- Dates: ISO 8601 strings (e.g., `"2026-02-05T10:30:00Z"`)
- Numbers: No string wrapping (e.g., `150.25`, not `"150.25"`)
- Booleans: `true`/`false` (not `1`/`0` or `"true"`/`"false"`)
- Null values: Use `null` (not `undefined` in JSON)

**Code Formatting:**
- Use Prettier defaults (already configured in project)
- Max line length: 100 characters
- Indent: 2 spaces
- Trailing commas: Always (ES5+)
- Semicolons: Required

---

## Communication Patterns

**State Management:**
- **Immutable Updates:** Always create new objects/arrays, never mutate
  ```typescript
  // ✓ Correct
  const updated = stocks.map(s => s.ticker === ticker ? { ...s, ...updates } : s);
  
  // ✗ Wrong
  const stock = stocks.find(s => s.ticker === ticker);
  stock.currentPrice = newPrice; // Mutation!
  ```

**Data Flow:**
- **Single Source of Truth:** Storage adapter is the only interface to persistence
  ```typescript
  // ✓ Correct - Use storage adapter
  import { getUserData, updateStock } from './lib/storage';
  
  // ✗ Wrong - Direct localStorage access
  localStorage.getItem('portfolio-assistant-data');
  ```

- **Edge Function Proxy:** All external API calls go through Edge Functions
  ```typescript
  // ✓ Correct - Call Edge Function
  const { data } = await supabase.functions.invoke('fetch-stock-data', { body: { ticker } });
  
  // ✗ Wrong - Direct API call
  fetch('https://finnhub.io/api/v1/quote?...');
  ```

---

## Process Patterns

**Error Handling:**
- Use fallback chain: API → Cache → Default
  ```typescript
  try {
    return await fetchFromAPI(ticker);
  } catch (apiError) {
    try {
      return await fetchFromCache(ticker);
    } catch (cacheError) {
      return getDefaultData(ticker); // Never throw to UI
    }
  }
  ```

**Loading States:**
- Show optimistic UI immediately
- Fetch data in background
- Update UI when data arrives
  ```typescript
  // Add stock immediately with defaults
  addStock({ ticker, name: ticker });
  setStocks(getUserData().stocks); // Show immediately
  
  // Fetch real data
  const data = await getStockData(ticker);
  updateStock(ticker, data);
  setStocks(getUserData().stocks); // Update UI
  ```

**Cache Strategy:**
- **Read:** Check cache first, fetch on miss
- **Write:** Update database and cache simultaneously
- **Invalidate:** 15-minute TTL on stock data (managed by Edge Function)

---

## Enforcement Guidelines

**Mandatory for All AI Agents:**

1. **Never bypass the storage adapter** - Always use `storage.ts` functions
2. **Never mutate state directly** - Use immutable patterns
3. **Never call external APIs directly** - Use Edge Functions
4. **Never use `any` type** - Explicitly type all data
5. **Never ignore TypeScript errors** - Fix them, don't suppress

**Code Review Checklist:**

- [ ] All naming follows conventions (database `snake_case`, code `camelCase`)
- [ ] No direct localStorage/sessionStorage access (use storage adapter)
- [ ] No direct Finnhub API calls (use Edge Function)
- [ ] All state updates are immutable
- [ ] Error handling has fallback chain
- [ ] Loading states show optimistic UI

---

## Examples & Anti-Patterns

**Example 1: Adding a Stock (Correct)**

```typescript
// ✓ Correct Flow
export async function handleAddStock(ticker: string) {
  // 1. Add to storage with defaults
  const stock = addStock({ ticker, name: ticker });
  
  // 2. Update UI immediately (optimistic)
  setStocks(getUserData().stocks);
  
  // 3. Fetch real data via Edge Function
  const { data, error } = await supabase.functions.invoke('fetch-stock-data', {
    body: { ticker }
  });
  
  if (!error && data) {
    // 4. Update storage immutably
    updateStock(ticker, {
      name: data.name,
      currentPrice: data.currentPrice,
      qualityScore: data.qualityScore,
      momentumScore: data.momentumScore,
      earningsScore: data.earningsScore,
      analystScore: data.analystScore
    });
    
    // 5. Refresh UI
    setStocks(getUserData().stocks);
  }
}
```

**Example 2: Adding a Stock (Anti-Pattern)**

```typescript
// ✗ WRONG - Multiple violations
async function addStockWrong(ticker: string) {
  // ✗ Direct localStorage access (bypass storage adapter)
  const data = JSON.parse(localStorage.getItem('portfolio-assistant-data'));
  
  // ✗ Direct mutation
  data.stocks.push({ ticker, name: ticker });
  
  // ✗ Direct API call (bypass Edge Function)
  const response = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${API_KEY}`);
  const quote = await response.json();
  
  // ✗ Mutation instead of immutable update
  data.stocks[data.stocks.length - 1].currentPrice = quote.c;
  
  // ✗ Direct localStorage write
  localStorage.setItem('portfolio-assistant-data', JSON.stringify(data));
  
  // ✗ No error handling, no optimistic UI, exposed API key
}
```

**Example 3: Database Query (Correct)**

```sql
-- ✓ Correct - snake_case, proper RLS
SELECT 
  ticker,
  current_price,
  quality_score,
  created_at
FROM stocks
WHERE user_id = auth.uid()
ORDER BY created_at DESC;
```

**Example 4: Database Query (Anti-Pattern)**

```sql
-- ✗ WRONG - Mixed case, no RLS consideration
SELECT 
  ticker,
  currentPrice,  -- ✗ camelCase in database
  quality_score
FROM stocks       -- ✗ No user_id filter (RLS bypass attempt)
ORDER BY ticker;
```

---

## Pattern Evolution

**When to Update These Patterns:**

- New architectural decisions require new patterns (e.g., adding Redis cache)
- Repeated bugs reveal pattern gaps (e.g., timezone handling not specified)
- Team/AI agents request clarification on ambiguous cases

**How to Propose Changes:**

1. Document the pattern gap or conflict
2. Propose solution with examples
3. Update this section via PR/agent workflow
4. Communicate to all active agents/developers

---

**Patterns Status:** ✅ Complete and enforced

---
