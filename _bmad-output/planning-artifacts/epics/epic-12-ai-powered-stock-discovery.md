# Epic 12: AI-Powered Stock Discovery (Gemini Flash)

Transform the Suggested Finds tab from static, hardcoded stock lists into a dynamic, AI-powered discovery engine using Google Gemini Flash. Groq remains dedicated to Portfolio tab trade signals; Gemini Flash handles all Suggested Finds intelligence.

**Builds on:** Epic 4 (Curated Stock Discovery) — "V2 AI-powered discovery"
**AI Provider:** Google Gemini 2.0 Flash (free tier / low cost, fast inference)
**Separation of Concerns:** Groq = Portfolio AI Analysis | Gemini = Suggested Finds Discovery

---

## Story 12.1: Gemini Proxy Edge Function

As a system,
I need a secure server-side proxy for the Google Gemini API,
So that API keys are never exposed to the browser and all AI discovery requests are routed securely.

**Acceptance Criteria:**

**Given** the system needs to call Gemini Flash for stock discovery
**When** a request is made to the `gemini-proxy` Edge Function
**Then** it proxies the request to the Gemini API with server-side credentials
**And** the `GEMINI_API_KEY` is stored as a Supabase secret (never in client code)
**And** CORS headers allow requests from the frontend origin

**Given** the Edge Function receives a valid request
**When** processing the request
**Then** it accepts a JSON payload with:
- `prompt` (string, required) — the discovery prompt
- `type` (enum: `"discover_compounders"` | `"discover_goldmines"` | `"analyze_themes"`, required)
- `temperature` (number, optional, default 0.7)
- `maxOutputTokens` (number, optional, default 4000)
**And** it calls `gemini-2.0-flash` model via the Gemini REST API
**And** returns the AI response as JSON: `{ text: string, model: string }`

**Given** the Gemini API returns an error or is rate-limited
**When** the error occurs
**Then** the Edge Function returns a structured error response with status code
**And** logs the error server-side for debugging
**And** the client receives a clean error message (no API key leakage)

**Given** the Edge Function receives a malformed request
**When** required fields are missing
**Then** it returns a 400 error with a descriptive message

**Technical Notes:**
- New file: `supabase/functions/gemini-proxy/index.ts`
- Follows the same pattern as existing `ai-proxy/index.ts` (Groq)
- Gemini REST endpoint: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`
- API key passed as query param `?key=` (Gemini standard) — never exposed to client
- No model fallback needed (Gemini Flash has generous rate limits)

---

## Story 12.2: AI Stock Discovery Service (Client-Side)

As the Suggested Finds feature,
I need a client-side service that orchestrates AI-powered stock discovery via Gemini,
So that users receive dynamic, intelligent stock suggestions instead of static hardcoded lists.

**Acceptance Criteria:**

**Given** the Suggested Finds tab needs AI-powered suggestions
**When** the discovery service is invoked
**Then** it builds structured prompts for Gemini Flash with:
- Clear archetype definition (Quiet Compounder criteria vs. Gold Mine criteria)
- Request for specific output format (ticker, name, reason, whyGreat, metrics)
- Instruction to return 5-8 stocks per archetype
- Current date context for market relevance

**Given** the service requests Quiet Compounder suggestions
**When** calling Gemini
**Then** the prompt instructs Gemini to find stocks matching:
- Consistent profitability (ROIC > 15%)
- Boring/unglamorous industries with durable demand
- Low volatility, stable businesses
- Long track records of steady growth
- Specific metrics: ROIC, margin, dividend history, CAGR
**And** the response is parsed into `EnhancedSuggestedStock[]` format

**Given** the service requests Gold Mine suggestions
**When** calling Gemini
**Then** the prompt instructs Gemini to:
- First identify the current dominant market theme (AI, energy transition, etc.)
- Find 5-8 stocks positioned in that theme's value chain
- Categorize each stock by its role (e.g., "Chips & Compute", "Infrastructure")
- Provide specific growth metrics and competitive moat analysis
**And** the response includes a `currentTheme` object with name, description, and categories

**Given** the user has stocks in their portfolio
**When** generating suggestions
**Then** the prompt includes the user's existing tickers
**And** instructs Gemini to EXCLUDE those tickers from suggestions
**And** may suggest complementary stocks that diversify the portfolio

**Given** AI suggestions have been fetched
**When** caching the results
**Then** results are cached in localStorage with a 24-hour TTL
**And** cache key includes the archetype type and a date stamp
**And** cache is invalidated if the user manually refreshes
**And** stale cache is used as fallback if the API call fails

**Given** the AI returns unexpected or malformed data
**When** parsing the response
**Then** the service gracefully handles parse errors
**And** returns an empty result with an error flag
**And** logs parsing errors to console for debugging
**And** does NOT fall back to hardcoded data — stale data is worse than no data

**Technical Notes:**
- New file: `app/src/lib/aiSuggestedFinds.ts`
- Output format must match existing `EnhancedSuggestedStock` interface
- Prompt engineering is critical — include few-shot examples in prompts
- 24h cache TTL (stock discovery doesn't need real-time freshness like trade signals)
- No hardcoded fallback — empty state with message if AI is unavailable
- Hardcoded `data/suggestedFinds.ts` can be removed or kept as dev reference only

---

## Story 12.3: Dynamic Market Theme Intelligence

As an investor,
I want the Gold Mines section to feature AI-identified trending market themes,
So that I discover stocks riding the current macro wave instead of a static theme.

**Acceptance Criteria:**

**Given** the user visits the Suggested Finds tab
**When** the Gold Mines section loads
**Then** it displays an AI-identified current market theme (not hardcoded)
**And** the theme includes:
- Theme name (e.g., "AI Infrastructure Build-Out", "Nuclear Renaissance", "GLP-1 Revolution")
- Theme description (1-2 sentences explaining why this theme is hot now)
- Value chain categories (3-5 categories within the theme)
**And** Gold Mine stocks are mapped to their category within the theme

**Given** market conditions change over time
**When** the 24-hour cache expires and suggestions are refreshed
**Then** Gemini may identify a different trending theme
**And** Gold Mine stocks update to reflect the new theme
**And** previously cached theme data is replaced

**Given** the AI identifies a theme
**When** displaying the theme context
**Then** the theme banner shows:
- Theme name with an appropriate icon/emoji
- Brief description of why it matters now
- "AI-identified" attribution badge
- Last updated timestamp
**And** the banner is visually distinct (amber/gold tone, matching current design)

**Technical Notes:**
- Theme identification is part of the Gold Mine discovery prompt (single API call)
- Replace hardcoded `currentTheme` export with AI-generated theme
- Fallback to hardcoded theme if AI call fails

---

## Story 12.4: AI-Enhanced Suggested Finds UI

As an investor,
I want the Suggested Finds tab to reflect its AI-powered nature with loading states, refresh capability, and freshness indicators,
So that I understand the suggestions are dynamic and can request fresh ideas.

**Acceptance Criteria:**

**Given** I navigate to the Suggested Finds tab
**When** AI suggestions are being fetched (no cache or cache expired)
**Then** I see skeleton loading placeholders for each section
**And** a subtle "Discovering stocks with AI..." message appears
**And** the loading state is smooth and non-jarring (shimmer animation)

**Given** AI suggestions have loaded successfully
**When** viewing the tab
**Then** each section header shows a small "AI-powered" badge (sparkle icon)
**And** a "Last updated: X hours ago" timestamp appears below the header
**And** a refresh button (🔄) is available in the tab header area
**And** the refresh button has a tooltip: "Get fresh AI suggestions"

**Given** I click the refresh button
**When** the button is clicked
**Then** the cached suggestions are invalidated
**And** new AI suggestions are fetched from Gemini
**And** a loading state appears while fetching
**And** new suggestions replace the old ones with a fade transition
**And** the "Last updated" timestamp resets to "Just now"
**And** the refresh button shows a spinning animation while loading

**Given** the AI call fails (network error, rate limit, etc.)
**When** the error occurs
**Then** the system uses cached suggestions if available (cache < 24h old)
**And** if no cache exists, the tab shows an empty state with the message:
  *"AI suggestions are unavailable right now. Hit refresh to try again."*
**And** the empty state is clean and centered, not an error dump
**And** the refresh button remains clickable for retry
**And** no hardcoded/stale data is shown — honest UX over fake content

**Given** suggestions are displayed
**When** I expand a stock row
**Then** the investment thesis (whyGreat bullets) is shown as AI-generated content
**And** an "AI-generated insight" micro-label appears in the expanded section
**And** the metrics display remains the same as current design

**Given** the tab is loaded with cached data
**When** the cache is less than 24 hours old
**Then** cached data is used immediately (no loading state)
**And** the "Last updated" shows the cache timestamp
**And** the refresh button is available for manual refresh

**Technical Notes:**
- Update `SuggestedFinds.tsx` component with new props and state management
- Add loading skeleton component (reuse pattern from other loading states if available)
- Sparkle icon from Lucide: `Sparkles`
- Keep existing `StockRow` component structure — just feed it AI data instead of hardcoded data
- Fallback chain: AI fresh → AI cached → Empty state with message (NO hardcoded data)

---

## Story 12.5: Suggested Finds Data Layer Refactor

As a developer,
I want a clean data layer that abstracts the suggestion source (AI vs. curated),
So that the UI component doesn't need to know where suggestions come from.

**Acceptance Criteria:**

**Given** the SuggestedFinds component needs data
**When** it requests suggestions
**Then** it calls a single hook: `useSuggestedFinds(existingTickers)`
**And** the hook handles:
- Checking localStorage cache first
- Calling Gemini proxy if cache is stale/missing
- Parsing and validating AI response
- Returning empty state with error flag on failure (no hardcoded fallback)
- Returning `{ compounders, goldMines, currentTheme, isLoading, error, lastUpdated, refresh }`

**Given** the hook returns data
**When** the component renders
**Then** it receives data in the exact same `EnhancedSuggestedStock[]` format
**And** the component doesn't know or care if data is AI-generated or curated
**And** the `isLoading` flag controls skeleton display
**And** the `refresh()` function triggers a fresh AI call

**Given** the existing curated data in `data/suggestedFinds.ts`
**When** the system is refactored
**Then** the curated data file can be removed or kept as dev reference only
**And** the hook is AI-only — no hardcoded fallback
**And** failure state = empty UI with message + refresh button

**Technical Notes:**
- New file: `app/src/hooks/useSuggestedFinds.ts`
- Uses the service from Story 12.2 internally
- Follows React hooks best practices (useEffect, useState, useCallback)
- Clean separation: hook → service → edge function → Gemini API
- Fallback chain: AI fresh → AI cached → Empty state with message (NO hardcoded data)

---

## Implementation Order

1. **Story 12.1** — Gemini Proxy Edge Function (backend foundation)
2. **Story 12.2** — AI Discovery Service (prompt engineering + parsing)
3. **Story 12.5** — Data Layer Hook (abstraction layer)
4. **Story 12.3** — Dynamic Theme Intelligence (Gold Mine enhancement)
5. **Story 12.4** — UI Enhancements (loading, refresh, badges)

## Dependencies

- Gemini API key provisioned and stored as Supabase secret
- Supabase CLI available for Edge Function deployment
- Existing Epic 4 UI structure (SuggestedFinds.tsx, StockRow component)

## Error State Philosophy

No hardcoded fallback. If Gemini is unavailable and cache is empty, show a clean empty state with a message and refresh button. Honest UX > stale data.

## Success Metrics

- Suggested Finds tab loads AI suggestions within 3-5 seconds
- Empty state with clear messaging when AI is unavailable (no fake/stale data)
- Groq usage is zero on the Suggested Finds tab
- 24-hour cache prevents excessive API calls
- Market themes feel timely and relevant (not frozen in time)
