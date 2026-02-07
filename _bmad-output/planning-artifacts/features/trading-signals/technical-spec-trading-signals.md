# Technical Specification — Trading Signals (Day Trade | Swing Trade)

**Feature:** Trading Signals  
**Date:** 2026-02-06  
**Audience:** Implementation (backend, AI, frontend).

This doc defines **how** to build Trading Signals. Product goals and scope are in [prd-trading-signals.md](./prd-trading-signals.md).

---

## 0. Context: Existing App Stack & APIs

Trading Signals is built **on top of** the same stack as the rest of Portfolio Assistant. Implementers should reuse existing patterns and services where possible.

### Frontend

- **React 18**, TypeScript, **Vite**, **Tailwind CSS 4**
- **Vercel** (hosting, Analytics, Speed Insights)
- Client routes: `/` (Portfolio), `/finds` (Suggested Finds), `/movers` (Market Movers). Trading Signals will add a new route/section (e.g. `/signals` or a tab).
- API keys never in the browser; all server calls go through Supabase Edge Functions using `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

### Backend

- **Supabase**: Edge Functions (Deno), PostgreSQL (e.g. `stock_cache`, `daily_suggestions`), Secrets for API keys.
- **Existing Edge Functions:**

| Function | Purpose | External API |
|----------|---------|--------------|
| `ai-proxy` | Portfolio BUY/SELL signals; model fallback | **Groq** (Llama 3.3 70B, Qwen3 32B fallback) |
| `gemini-proxy` | Suggested Finds (Compounders, Gold Mines); key rotation + model cascade | **Google Gemini** (2.5 Flash, 2.0 Flash, 2.0 Flash Lite) |
| `fetch-stock-data` | Stock data proxy; 15-min server cache in `stock_cache` | **Finnhub** (quote, metrics, recommendations, earnings, **news**, general_news) |
| `daily-suggestions` | Shared daily cache for Suggested Finds | PostgreSQL |
| `scrape-market-movers` | Gainers/losers screener | Yahoo Finance |
| `fetch-yahoo-news` | Company-specific news | Yahoo Finance |

### Existing data APIs (used elsewhere on the site)

- **Finnhub** (via `fetch-stock-data`): quotes, fundamentals, earnings, analyst recommendations, **company news** (7-day window), **general news**. Cached per ticker/endpoint; TTL 15 min. Used by Portfolio (conviction, news) and Suggested Finds (metrics + general_news).
- **Groq**: Portfolio AI analysis only.
- **Google Gemini**: Suggested Finds discovery only.
- **Yahoo Finance**: Market Movers list and company news (separate from Finnhub).

### How Trading Signals fits in

- **New Supabase Edge Function** (e.g. `trading-signals` or `signals-proxy`): orchestrates candles → news → Sentiment Agent → Trade Agent; returns trade JSON + chart payload. Same CORS and auth pattern as `ai-proxy` / `fetch-stock-data` (Bearer anon key).
- **Together AI:** new provider for Trade (and optionally Sentiment) agents; add `TOGETHER_API_KEY` to Supabase secrets. Same “proxy + server-side key” pattern as Groq/Gemini.
- **Twelve Data (MVP):** new provider for OHLCV candles; add key to Supabase secrets. Not used elsewhere today.
- **Finnhub news:** reuse existing `fetch-stock-data` company-news endpoint or same cache key (`news:{ticker}`) so Trading Signals does not double-call; respect same 15–30 min TTL and rate limits.
- **Frontend:** same React/Vite app; new page or tab calls the new Edge Function and renders trade + chart (e.g. TradingView Lightweight Charts).

Keeping this context in mind keeps keys server-side, avoids duplicate Finnhub usage, and aligns error handling and caching with the rest of the app.

---

## 1. Day Trade Agent — Prompts & Output

**Purpose:** minutes → hours. **Timeframes:** 1m / 15m / 1h. **Behavior:** fast, selective, risk-tight.

### System prompt

You are a professional intraday trader and risk manager specializing in short-term equity trading. Your task is to analyze multi-timeframe intraday price action together with short-term news sentiment to generate a single, actionable DAY TRADE recommendation. Primary objective: capital preservation and high-quality intraday setups. Do NOT force trades. HOLD is a valid and common outcome.

### User prompt (inputs)

(1) **Technical price action:** 1m candles (execution/entry precision), 15m (intraday structure/momentum), 1h (trend bias/key levels). Each candle: time, open, high, low, close, volume.  
(2) **24-hour news sentiment:** category (Positive/Neutral/Negative), score (-1 to +1), rationale.

Placeholders: `Technical Data (Intraday): {{ JSON.stringify($json.data[0]) }}`, `Sentiment Analysis (24h): {{ JSON.stringify($json.data[1]) }}`.

### Analysis process (strict)

1. Intraday trend bias from 1h.  
2. Momentum/structure from 15m.  
3. Entry timing from 1m + volume.  
4. News as confirmation/risk filter.  
5. If choppy, extended, or sentiment conflicts with technicals → HOLD.

### Risk rules

- Entry near current price and justified.  
- Stop beyond recent intraday swing.  
- Target ≥ 1.5× risk.  
- Avoid unclear/low-liquidity.  
- Use most recent 1m close as current price.

### Output format (strict JSON, no extra text)

```json
{
  "mode": "DAY_TRADE",
  "recommendation": "BUY | SELL | HOLD",
  "entryPrice": number | null,
  "stopLoss": number | null,
  "targetPrice": number | null,
  "riskReward": "1:x" | null,
  "rationale": {
    "technical": "...",
    "sentiment": "...",
    "risk": "..."
  },
  "confidence": "LOW | MEDIUM | HIGH"
}
```

---

## 2. Swing Trade Agent — Prompts & Output

**Purpose:** days → weeks. **Timeframes:** 4h / 1d / 1w. **Behavior:** slower, higher conviction, trend-first.

### System prompt

You are a professional swing trader and portfolio risk manager. Your task is to analyze higher-timeframe technical price action together with recent news sentiment to generate a single, high-conviction SWING TRADE recommendation. Primary objective: trade with the dominant trend and favorable risk/reward. Patience is critical. HOLD is expected when conditions are not optimal.

### User prompt (inputs)

(1) **Technical:** 4h (setup structure/timing), 1d (trend confirmation/key levels), 1w (macro/dominant trend). Each candle: time, o, h, l, c, volume.  
(2) **24h to multi-day news sentiment:** category, score, rationale (dominant narrative).

Placeholders: `Technical Data (Higher Timeframes): {{ JSON.stringify($json.data[0]) }}`, `Sentiment Analysis: {{ JSON.stringify($json.data[1]) }}`.

### Analysis process (strict)

1. Dominant trend from weekly.  
2. Trend strength/structure from daily.  
3. Entry zone from 4h.  
4. Sentiment as confirmation/caution.  
5. If higher timeframes don't align → HOLD.

### Risk rules

- Entry near clear technical level (support/resistance/retest).  
- Stop beyond major swing.  
- Target ≥ 2× risk.  
- No counter-trend unless R:R > 3× and structure supports reversal.  
- Use most recent 4h close as current price.

### Output format

Same JSON shape as Day Trade but `"mode": "SWING_TRADE"` and rationale wording for higher-timeframe trend and multi-day reward logic.

---

## 3. Key Differences (Day vs Swing)

| Aspect            | Day Trade   | Swing Trade   |
|-------------------|-------------|---------------|
| Default outcome   | HOLD        | HOLD          |
| News weight       | High        | Moderate      |
| Risk/Reward       | ≥ 1.5×      | ≥ 2×          |
| Trend alignment   | Helpful     | Mandatory     |
| Entry precision   | Critical    | Flexible      |
| User psychology   | Fast        | Patient       |

**Rule:** Do NOT reuse one prompt and "toggle words." Separate agents = better outputs. Keep output schema identical for a simple frontend. Default the site to Swing Trade.

---

## 4. Data Sources

### Candlestick (OHLCV)

- **Twelve Data (MVP):** 1m, 5m, 15m, 1h, 4h, 1d, 1w. REST `https://api.twelvedata.com/time_series`. Example: `?symbol=AAPL&interval=1h&outputsize=100&apikey=KEY`. Works for both modes; slight latency.  
- **Polygon.io (production):** Professional-grade, fast; US equities. Example: `/v2/aggs/ticker/AAPL/range/1/hour/...`.  
- **Alpaca:** Clean API, future trading integration; volume + trades.

**Requirements by mode:**  
- **Day:** 1m (entry), 15m (structure), 1h (trend). Fetch ≥ 100 candles per timeframe.  
- **Swing:** 4h (setup), 1d (trend), 1w (macro). Same.

### News & sentiment

- **Chosen: Finnhub** for news in Trading Signals. Already in the stack (portfolio, Suggested Finds); one provider, one key, finance-focused. Use company news endpoint; filter to last 24–72h for sentiment.  
- **Avoiding API limits:** Cache news per ticker in the Edge Function (or Supabase/KV). Recommended TTL: 15–30 minutes so repeated signal requests for the same symbol don’t hit Finnhub every time. If the app already fetches Finnhub news elsewhere, consider reusing that response or a shared cache key (e.g. `news:{ticker}`) so Trading Signals doesn’t double-call. Respect Finnhub free-tier rate limits; add exponential backoff and a single in-flight request per ticker if needed.

### Sentiment pipeline

**Do not use raw news alone.** News ≠ sentiment.

**Correct pipeline:**  
Raw articles → **Sentiment AI Agent** → Structured sentiment (category + score + rationale) → **Trade Decision Agent**.

### Sentiment Agent contract (input → output)

- **Input:** Array of recent news items per ticker. Each item: `headline`, `summary` (optional), `source`, `datetime`, `url`. Same shape as Finnhub company-news (or normalized from it).
- **Output:** Single structured object per request, matching **Sentiment Data** in §6: `category` (e.g. Positive | Neutral | Negative), `score` (-1 to +1), `summary`, `keyDrivers` (optional array of short strings). The Trade Agent consumes this only; it must not receive raw headlines.
- **Implementation:** Can be the same LLM provider (e.g. Together) with a dedicated system prompt that accepts raw news and returns only the structured sentiment JSON. Cache sentiment per ticker with a short TTL (e.g. 15–30 min) when reusing for multiple signal requests.

---

## 5. Technical Indicators & Backend Flow

### Indicators (precompute outside LLM)

Compute server- or client-side; pass into the Trade Agent as part of Technical Data. Deterministic, repeatable, less hallucination.

- RSI (14)  
- ATR (14)  
- VWAP (intraday)  
- EMA / SMA (20, 50, 200)  
- Recent support/resistance (swing highs/lows)

### Backend flow

```
User selects ticker + mode
        ↓
Fetch candles (by mode)
        ↓
Compute indicators
        ↓
Fetch recent news
        ↓
Run Sentiment Agent
        ↓
Run Trade Agent (Day or Swing)
        ↓
Return JSON to frontend
```

---

## 6. Data Contracts

### Technical Data (input to Trade Agent)

```json
{
  "timeframes": {
    "1h": { "candles": [...], "indicators": {...} },
    "15m": { "candles": [...], "indicators": {...} },
    "1m": { "candles": [...], "indicators": {...} }
  },
  "currentPrice": 183.42
}
```

### Sentiment Data (input to Trade Agent)

```json
{
  "category": "Neutral",
  "score": 0.05,
  "summary": "...",
  "keyDrivers": [...]
}
```

### API response (trade + chart for frontend)

- **trade:** recommendation, entryPrice, stopLoss, targetPrice, riskReward, confidence, rationale (technical, sentiment, risk).  
- **chart:** `timeframe`, `candles` (array with t, o, h, l, c, v), `overlays`: lines for Entry, Stop, Target.

Example:

```json
{
  "trade": {
    "recommendation": "BUY",
    "entryPrice": 184.5,
    "stopLoss": 179.8,
    "targetPrice": 194.0,
    "riskReward": "1:2.0",
    "confidence": "MEDIUM",
    "rationale": {
      "technical": "...",
      "sentiment": "...",
      "risk": "..."
    }
  },
  "chart": {
    "timeframe": "1d",
    "candles": [
      { "t": "2026-02-06T00:00:00Z", "o": 183.1, "h": 185.2, "l": 182.7, "c": 184.9, "v": 61234567 }
    ],
    "overlays": [
      { "type": "line", "label": "Entry", "price": 184.5 },
      { "type": "line", "label": "Stop", "price": 179.8 },
      { "type": "line", "label": "Target", "price": 194.0 }
    ]
  }
}
```

---

## 7. Chart, UX & Gotchas

### Chart data source

Reuse the same OHLCV payload used for the AI. Return candles to the frontend (or lightly normalized). Same payload drives both the Trade Agent and the chart.

### Chart libraries

- **TradingView Lightweight Charts:** Candles + volume + horizontal levels; fast, free, common.  
- **react-financial-charts:** React-first; heavier.

### UX

- Don't show all timeframes at once.  
- **Primary chart:** 15m for day, 1d for swing.  
- **Dropdown:** 1m / 15m / 1h (day) or 4h / 1d / 1w (swing).  
- Keep overlays (entry/stop/target) constant across timeframe switches.

### Error handling (Edge Function)

- Return **4xx** for bad input (e.g. missing ticker, invalid mode) with a JSON body: `{ "error": "message" }`.
- Return **5xx** for upstream failures (Twelve Data, Finnhub, Together) with a JSON body; optionally include `stale: true` and cached trade/chart if a previous successful response exists for that ticker (same pattern as `fetch-stock-data` stale fallback).
- Use timeouts for external calls (candles, news, LLM) and fail gracefully; avoid long hangs. Prefer a short error message to the user over an indefinite loading state.

### Practical gotchas

| Gotcha | Guidance |
|--------|----------|
| **Time zones** | Store and transmit in UTC; display in the user’s (local) timezone in the UI. |
| **Market hours** | 1m data is often sparse pre/post market depending on provider. |
| **Caching** | Cache candles per ticker+interval: ~15–60 seconds for day mode, longer for swing. |
| **Rate limits** | Twelve Data free tier is fine, but caching helps a lot. |
