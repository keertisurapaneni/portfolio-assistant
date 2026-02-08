# Portfolio Assistant

AI-powered stock signals — skip the noise, catch the plays.

A personal investing decision-support tool that combines automated conviction scoring, AI portfolio analysis, and actionable trading signals to help you know when to buy, sell, or sit tight.

**Live:** [portfolioassistant.org](https://portfolioassistant.org)

## Features

### My Portfolio (`/`)

- **Conviction Scoring** — Automated 0-100 score based on 4 factors: Quality (30%), Earnings (30%), Analyst (25%), Momentum (15%)
- **AI Trade Signals** — BUY/SELL recommendations powered by Groq LLMs with risk-adjusted guardrails
- **Risk Appetite** — Aggressive / Moderate / Conservative profiles that shape AI buy/sell logic
- **Brokerage Integration** — Connect Schwab, IBKR, Robinhood & [more](https://snaptrade.com/brokerage-integrations) via SnapTrade to auto-import holdings
- **Authentication** — Optional email/password login (Supabase Auth) to save portfolio across devices
- **Portfolio Import** — CSV/Excel upload with smart column detection (ticker, shares, avg cost)
- **News Headlines** — Latest company-specific news on each card with clickable links
- **Portfolio Value** — Per-stock + total portfolio with daily P&L
- **Guest Mode** — Works without login; portfolio saved in browser localStorage

### Trade Signals (`/signals`)

- **Auto Mode** — Automatically picks Day or Swing based on ATR% and ADX volatility analysis (default)
- **Day Trade** — Intraday signals (1m/15m/1h timeframes) with technical indicators
- **Swing Trade** — Multi-day/week signals (4h/1d/1w timeframes) with technical indicators
- **Technical Indicator Engine** — Pre-computed RSI, MACD, EMA/SMA, ATR, ADX, volume ratio, support/resistance fed to AI
- **Market Context** — SPY trend + VIX volatility snapshot included in every analysis
- **Scenario Analysis** — Bullish/neutral/bearish scenarios with probability estimates
- **Confidence Score** — 0-10 visual confidence rating with dual price targets
- **Interactive Charts** — Candlestick charts with entry/stop/target overlays (2-3 years of history for swing)
- Powered by Gemini (multi-key rotation) + Twelve Data (candles + indicators) + Yahoo Finance (news)

### Suggested Finds (`/finds`)

- **Quiet Compounders** — AI-discovered under-the-radar quality stocks backed by Finnhub fundamentals
- **Gold Mines** — Macro-theme-driven opportunities diversified across the value chain
- Powered by HuggingFace Inference API with model cascade (Qwen2.5-72B → Mixtral-8x7B → Llama-3.1-8B)
- Server-side daily cache — same picks for everyone each day, saves AI tokens

### Market Movers (`/movers`)

- Top 25 gainers and losers from Yahoo Finance
- Sortable columns (Price, Change, Change %)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     DNS: Squarespace                                │
│              portfolioassistant.org → Vercel                        │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│                     Vercel (Frontend)                                │
│          React 18 · TypeScript · Vite · Tailwind CSS 4              │
│          Client-side routing: / , /signals , /finds , /movers       │
│          Supabase Auth (optional email/password login)              │
└──────┬────────────┬────────────────────┬────────────────────────────┘
       │            │                    │
       │ Portfolio  │ Trade Signals      │  Suggested Finds
       │ AI         │                    │
┌──────▼─────────┐ ┌▼──────────────────┐ ┌▼──────────────────────────┐
│ Supabase Edge  │ │ Supabase Edge     │ │ Supabase Edge             │
│ Functions      │ │ Functions         │ │ Functions                 │
│                │ │                   │ │                           │
│ ai-proxy       │ │ trading-signals   │ │ huggingface-proxy         │
│ └─ Groq API    │ │ ├─ Twelve Data    │ │ └─ HuggingFace API        │
│    ├─ llama-   │ │ │  (candles)      │ │    ├─ Qwen2.5-72B        │
│    │  3.3-70b  │ │ ├─ Yahoo Finance  │ │    ├─ Mixtral-8x7B       │
│    └─ qwen3-   │ │ │  (news)         │ │    └─ Llama-3.1-8B       │
│       32b      │ │ └─ Gemini         │ │                           │
│                │ │    (sentiment +   │ │ daily-suggestions         │
│ fetch-stock-   │ │     trade agent)  │ │ └─ PostgreSQL (shared     │
│ data           │ │    key rotation   │ │    daily cache)           │
│ └─ Finnhub API │ │                   │ │                           │
│                │ └───────────────────┘ └───────────────────────────┘
│ broker-connect │
│ └─ SnapTrade   │   ┌─────────────────────────────────────────────┐
│    (register,  │   │  Supabase PostgreSQL (RLS)                  │
│    login, dis- │   │  ├─ portfolios (user tickers + positions)   │
│    connect)    │   │  ├─ broker_connections (SnapTrade creds)    │
│                │   │  ├─ user_settings (risk profile)            │
│ broker-sync    │   │  └─ daily_suggestions (shared AI cache)     │
│ └─ SnapTrade   │   └─────────────────────────────────────────────┘
│    (positions) │
│                │
│ scrape-market- │   ┌─────────────────────────────────────────────┐
│ movers         │   │  Storage Strategy                           │
│ └─ Yahoo       │   │  Guest: localStorage (browser-only)         │
│    Finance     │   │  Authed: Supabase PostgreSQL (cloud)        │
│                │   │         + localStorage (market data cache)  │
│ fetch-yahoo-   │   └─────────────────────────────────────────────┘
│ news           │
│ └─ Yahoo       │
│    Finance     │
└────────────────┘
```

### How the AI Layers Work

| Layer | Purpose | AI Model | Data Sources |
|---|---|---|---|
| **Conviction Scoring** | Automated 0-100 score per stock | None (rule-based) | Finnhub metrics, earnings, recommendations |
| **Portfolio Trade Signals** | BUY / SELL / no-action per stock | Groq (Llama 3.3 70B) | Finnhub data + market news + risk profile |
| **Trade Signals** | Auto/Day/Swing trade with indicators, scenarios, dual targets | Gemini (multi-key rotation) | Twelve Data candles → Indicator Engine (RSI, MACD, EMA, ATR, ADX) + Yahoo Finance news + SPY/VIX market context |
| **Quiet Compounders** | Discover quality under-the-radar stocks | HuggingFace (Qwen2.5-72B) | Finnhub metrics + general market news |
| **Gold Mines** | Macro-theme-driven opportunities | HuggingFace (Qwen2.5-72B) | Market news + Finnhub fundamentals |

### Edge Functions

| Function | Purpose | External API |
|---|---|---|
| `ai-proxy` | Portfolio AI analysis with model fallback | Groq |
| `trading-signals` | Day/Swing signals with parallel AI agents | Twelve Data + Yahoo Finance + Gemini |
| `huggingface-proxy` | Suggested Finds AI with model cascade | HuggingFace |
| `gemini-proxy` | Gemini proxy for client-side AI calls | Google Gemini |
| `daily-suggestions` | Shared daily cache (GET/POST/DELETE) | PostgreSQL |
| `fetch-stock-data` | Stock data proxy with server-side cache | Finnhub |
| `scrape-market-movers` | Gainers/losers screener with retry logic | Yahoo Finance |
| `fetch-yahoo-news` | Company-specific news | Yahoo Finance |
| `broker-connect` | SnapTrade registration, login portal, disconnect | SnapTrade |
| `broker-sync` | Fetch and normalize brokerage positions | SnapTrade |

**API keys never touch the browser** — all sensitive keys stored as Supabase secrets.

## Quick Start

### Prerequisites

- Node.js 18+ (LTS recommended)
- Supabase account + CLI (with Auth enabled — email provider, confirm email OFF)
- Finnhub API key (free: [finnhub.io](https://finnhub.io/register))
- Groq API key (free: [console.groq.com](https://console.groq.com))
- Google Gemini API key (free: [aistudio.google.com](https://aistudio.google.com/apikey))
- HuggingFace API key (free: [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens))
- Twelve Data API key (free: [twelvedata.com](https://twelvedata.com/account/api-keys))
- SnapTrade API credentials (optional, for broker integration: [snaptrade.com](https://snaptrade.com))

### Setup

```bash
# Clone and install
git clone <repo-url>
cd portfolio-assistant/app
npm install

# Configure environment
cp .env.example .env
# Edit .env with your Supabase URL and anon key
```

### Environment Variables

| Variable                 | Description              | Where to Get                        |
| ------------------------ | ------------------------ | ----------------------------------- |
| `VITE_SUPABASE_URL`      | Supabase project URL     | Supabase Dashboard → Settings → API |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon/public key | Supabase Dashboard → Settings → API |

**Supabase Secrets** (set via CLI, not in .env):

```bash
supabase secrets set FINNHUB_API_KEY=your_key
supabase secrets set GROQ_API_KEY=your_key
supabase secrets set GEMINI_API_KEY=your_key
supabase secrets set GEMINI_API_KEY_2=your_key           # optional, add more (_3, _4, …) for rate-limit rotation
supabase secrets set TWELVE_DATA_API_KEY=your_key
supabase secrets set HUGGINGFACE_API_KEY=your_key
supabase secrets set SNAPTRADE_CLIENT_ID=your_client_id  # optional, broker integration
supabase secrets set SNAPTRADE_CONSUMER_KEY=your_key     # optional
```

### Run

```bash
npm run dev
# Open http://localhost:5173
```

### Deploy

```bash
# Deploy all Edge Functions
supabase functions deploy --no-verify-jwt

# Run database migrations
supabase db push

# Frontend auto-deploys to Vercel on git push to master
# Commits prefixed with docs:, chore:, or ci: skip deployment
git push origin master
```

## Available Scripts

```bash
npm run dev      # Start development server
npm run build    # Build for production (tsc + vite)
npm run preview  # Preview production build
npm run lint     # Run ESLint
```

## Commit Conventions

Vercel auto-deploys on push to `master`, **except** commits prefixed with:

| Prefix | Example | Vercel |
|---|---|---|
| `feat:` | `feat: add routing` | Deploys |
| `fix:` | `fix: Gold Mine diversity` | Deploys |
| `docs:` | `docs: update README` | **Skipped** |
| `chore:` | `chore: clean up artifacts` | **Skipped** |
| `ci:` | `ci: update build config` | **Skipped** |

## Troubleshooting

| Issue              | Fix                                                                       |
| ------------------ | ------------------------------------------------------------------------- |
| Port 5173 in use   | `lsof -ti:5173 \| xargs kill -9`                                          |
| .env not loading   | Must be in `app/` directory, vars need `VITE_` prefix, restart dev server |
| 429 rate limits    | Wait 15s (auto-cooldown), or reduce portfolio size                        |
| AI signals missing | Hit refresh — signals don't load from cache on page load                  |
| Build errors       | `rm -rf node_modules && npm install` then `npm run build`                 |
| Chart time error   | Intraday candles use Unix timestamps; daily use YYYY-MM-DD strings        |

## License

Personal project — not for redistribution.
