# Epic 7: AI-Powered Trade Signals (IMPLEMENTED)

Users receive AI-generated BUY/SELL trade signals powered by Groq's Llama 3.3 70B model, with mechanical guardrails for stop-loss, profit-taking, and overconcentration.

**Status:** ✅ Fully implemented

**New FRs covered:**

- FR49: AI generates BUY/SELL/null trade signals per stock via LLM
- FR50: AI signals display on main stock cards and detail view (single source of truth)
- FR51: Mechanical guardrails fire SELL for stop-loss, profit-take, and overconcentration before AI call
- FR52: Guardrail thresholds adjust based on user's risk profile (Aggressive/Moderate/Conservative)
- FR53: AI calls are routed through Supabase Edge Function (API keys never exposed to browser)
- FR54: Two-model pipeline: Llama 3.3 70B primary, Qwen3 32B fallback on rate limit
- FR55: AI results cached for 4 hours per stock with prompt-version-based invalidation
- FR56: Trigger detection skips AI call when no actionable catalyst exists (saves tokens)
- FR57: AI progress bar shows per-stock analysis status during refresh
- FR58: Failed stocks auto-retry after 10s cooldown
- FR59: AI system message includes few-shot examples, trading rules, and analyst persona

## Story 7.1: AI Proxy Edge Function

As a developer,
I want AI API calls routed through a Supabase Edge Function,
So that API keys are never exposed in the browser.

**Acceptance Criteria:**

**Given** the user triggers an AI analysis refresh
**When** each stock is analyzed
**Then** the call goes to `ai-proxy` Edge Function → Groq API
**And** Groq API key is stored as a Supabase secret (not in .env)
**And** the Edge Function strips `<think>` tags and markdown fences from responses
**And** the response includes the model used (for debugging)

---

## Story 7.2: Two-Model Fallback Pipeline

As a user,
I want AI analysis to complete even when rate limits are hit,
So that I get signals for all my stocks.

**Acceptance Criteria:**

**Given** the primary model (70B) returns 429
**When** the Edge Function receives the rate limit
**Then** it immediately retries with the fallback model (32B)
**And** if the fallback also 429s, it waits 3s and retries once more
**And** the client retries any still-failed stocks after a 10s cooldown

---

## Story 7.3: AI Trade Signal Display

As an investor,
I want to see AI-generated BUY/SELL signals on my stock cards,
So that I know what action to take today.

**Acceptance Criteria:**

**Given** AI analysis has completed
**When** viewing the portfolio
**Then** each stock card shows a BUY (green) or SELL (red) badge if the AI recommends action
**And** a 5-8 word card note summarizes the reason
**And** clicking the card shows the full AI reasoning (2-3 sentences)
**And** the main card and detail view always show the same signal (no discrepancies)

---

## Story 7.4: Trigger-Based Analysis

As a system,
I want to skip AI calls for stocks with no actionable trigger,
So that token usage stays within free-tier limits.

**Acceptance Criteria:**

**Given** a stock has no significant price move, no stop-loss/profit-take zone, no overconcentration, and no earnings news
**When** AI analysis runs
**Then** the stock is skipped (returns null instantly, no API call)
**And** only stocks with triggers consume tokens

---

## Story 7.5: Mechanical SELL Guardrails

As an investor,
I want automatic SELL signals for clear-cut risk situations,
So that stop-losses and profit-taking are never missed.

**Acceptance Criteria:**

**Given** a stock hits the stop-loss threshold (risk-profile adjusted)
**When** AI analysis runs
**Then** a SELL signal is immediately returned without calling the LLM
**And** the reasoning explains the threshold breach
**And** the same logic applies for profit-taking and overconcentration

---

## Story 7.6: AI Analysis Progress Indicator

As a user,
I want to see which stock is being analyzed and how many are done,
So that I know the refresh is still working.

**Acceptance Criteria:**

**Given** AI analysis is running after a refresh
**When** viewing the portfolio
**Then** a purple progress bar shows "AI analyzing {TICKER}... (X/Y)"
**And** the bar fills proportionally as stocks complete
**And** if retries happen, the bar shows "waiting to retry..." then "retrying {TICKER}"
**And** the bar disappears when all stocks are done

---
