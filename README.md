# Portfolio Assistant

AI-powered stock signals — skip the noise, catch the plays.

A personal investing decision-support tool that combines automated conviction scoring, AI portfolio analysis, and actionable trading signals to help you know when to buy, sell, or sit tight.

**Live:** [portfolioassistant.org](https://portfolioassistant.org)

## Features

### My Portfolio (`/`)

- **Conviction Scoring** — Automated 0-100 score based on 4 factors: Quality (30%), Earnings (30%), Analyst (25%), Momentum (15%)
- **AI Trade Signals** — BUY/SELL recommendations powered by Groq LLMs with risk-adjusted guardrails
- **Risk Appetite** — Aggressive / Moderate / Conservative profiles that shape AI buy/sell logic
- **Portfolio Import** — CSV/Excel upload with smart column detection (ticker, shares, avg cost)
- **News Headlines** — Latest company-specific news on each card with clickable links
- **Portfolio Value** — Per-stock + total portfolio with daily P&L

### Trading Signals (`/signals`)

- **Day Trade** — Intraday signals (1m/15m/1h timeframes), R:R 1:1.5–1:2, high news weight
- **Swing Trade** — Multi-day/week signals (4h/1d/1w timeframes), R:R 1:2–1:4, trend alignment mandatory
- **Interactive Charts** — Candlestick charts with entry/stop/target overlays (2-3 years of history for swing)
- **Live Timer** — Elapsed seconds counter while signal is being generated
- Powered by Gemini (4-key rotation for rate limits) + Twelve Data (candles) + Yahoo Finance (news)

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
└──────┬────────────┬────────────────────┬────────────────────────────┘
       │            │                    │
       │ Portfolio  │ Trading Signals    │  Suggested Finds
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
│ data           │ │    4-key rotation │ │    daily cache)           │
│ └─ Finnhub API │ │                   │ │                           │
│                │ └───────────────────┘ └───────────────────────────┘
│ scrape-market- │
│ movers         │
│ └─ Yahoo       │
│    Finance     │
│                │
│ fetch-yahoo-   │
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
| **Trading Signals** | Day/Swing trade with entry, stop, target | Gemini (4-key rotation) | Twelve Data candles + Yahoo Finance news |
| **Quiet Compounders** | Discover quality under-the-radar stocks | HuggingFace (Qwen2.5-72B) | Finnhub metrics + general market news |
| **Gold Mines** | Macro-theme-driven opportunities | HuggingFace (Qwen2.5-72B) | Market news + Finnhub fundamentals |

### Edge Functions

| Function | Purpose | External API |
|---|---|---|
| `ai-proxy` | Portfolio AI analysis with model fallback | Groq |
| `trading-signals` | Day/Swing signals with parallel data fetch | Twelve Data + Yahoo Finance + Gemini |
| `huggingface-proxy` | Suggested Finds AI with model cascade | HuggingFace |
| `gemini-proxy` | Gemini proxy for client-side AI calls | Google Gemini |
| `daily-suggestions` | Shared daily cache (GET/POST/DELETE) | PostgreSQL |
| `fetch-stock-data` | Stock data proxy with 15-min server cache | Finnhub |
| `scrape-market-movers` | Gainers/losers screener with retry logic | Yahoo Finance |
| `fetch-yahoo-news` | Company-specific news | Yahoo Finance |

**API keys never touch the browser** — all sensitive keys stored as Supabase secrets.

## Quick Start

### Prerequisites

- Node.js 18+ (LTS recommended)
- Supabase account + CLI
- Finnhub API key (free: [finnhub.io](https://finnhub.io/register))
- Groq API key (free: [console.groq.com](https://console.groq.com))
- Google Gemini API key (free: [aistudio.google.com](https://aistudio.google.com/apikey))
- HuggingFace API key (free: [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens))
- Twelve Data API key (free: [twelvedata.com](https://twelvedata.com/account/api-keys))

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
supabase secrets set GEMINI_API_KEY_2=your_second_key    # optional, for rate-limit rotation
supabase secrets set GEMINI_API_KEY_3=your_third_key     # optional
supabase secrets set GEMINI_API_KEY_4=your_fourth_key    # optional
supabase secrets set TWELVE_DATA_API_KEY=your_key
supabase secrets set HUGGINGFACE_API_KEY=your_key
```

### Run

```bash
npm run dev
# Open http://localhost:5173
```

### Deploy

```bash
# Deploy Edge Functions
supabase functions deploy fetch-stock-data --no-verify-jwt
supabase functions deploy ai-proxy --no-verify-jwt
supabase functions deploy huggingface-proxy --no-verify-jwt
supabase functions deploy gemini-proxy --no-verify-jwt
supabase functions deploy daily-suggestions --no-verify-jwt
supabase functions deploy scrape-market-movers --no-verify-jwt
supabase functions deploy fetch-yahoo-news --no-verify-jwt
supabase functions deploy trading-signals --no-verify-jwt

# Frontend auto-deploys to Vercel on git push to master
# Commits prefixed with docs:, chore:, or ci: skip deployment
git push origin master
```

## Project Structure

```
portfolio-assistant/
├── app/                            # React frontend (Vite)
│   ├── src/
│   │   ├── components/             # UI components
│   │   │   ├── Dashboard.tsx       # Portfolio overview + risk appetite
│   │   │   ├── StockCard.tsx       # Individual stock card
│   │   │   ├── StockDetail.tsx     # Slide-over detail panel
│   │   │   ├── TradingSignals.tsx  # Day/Swing signals + chart
│   │   │   ├── MarketMovers.tsx    # Gainers/losers tables
│   │   │   ├── SuggestedFinds.tsx  # Quiet Compounders + Gold Mines
│   │   │   ├── SettingsModal.tsx   # Risk profile settings
│   │   │   ├── AddTickersModal.tsx
│   │   │   └── ImportPortfolioModal.tsx
│   │   ├── lib/                    # Business logic
│   │   │   ├── aiInsights.ts       # AI trade signals (Groq) + caching
│   │   │   ├── aiSuggestedFinds.ts # AI discovery (HuggingFace) + server cache
│   │   │   ├── tradingSignalsApi.ts # Trading Signals API client
│   │   │   ├── convictionEngine.ts # 4-factor scoring engine
│   │   │   ├── stockApiEdge.ts     # Finnhub API integration
│   │   │   ├── stockApi.ts         # Stock API helpers
│   │   │   ├── portfolioCalc.ts    # Portfolio weight calculations
│   │   │   ├── settingsStorage.ts  # Risk profile persistence
│   │   │   ├── storage.ts          # localStorage CRUD
│   │   │   ├── importParser.ts     # CSV/Excel parsing
│   │   │   ├── warnings.ts         # Risk warning logic
│   │   │   └── utils.ts            # Tailwind helpers
│   │   ├── hooks/
│   │   │   └── useSuggestedFinds.ts # Discovery hook with cache logic
│   │   ├── types/index.ts          # TypeScript types
│   │   └── App.tsx                 # Routing + layout + AI orchestration
│   └── vercel.json                 # SPA rewrites
├── vercel.json                     # Build config + ignoreCommand
├── supabase/
│   ├── functions/                  # Edge Functions (Deno)
│   │   ├── ai-proxy/              # Groq proxy (portfolio analysis)
│   │   ├── trading-signals/       # Day/Swing signal pipeline
│   │   ├── huggingface-proxy/     # HuggingFace proxy (suggested finds)
│   │   ├── gemini-proxy/          # Gemini proxy (client AI calls)
│   │   ├── daily-suggestions/     # Shared daily cache CRUD
│   │   ├── fetch-stock-data/      # Finnhub proxy + 15-min cache
│   │   ├── scrape-market-movers/  # Yahoo Finance screener
│   │   └── fetch-yahoo-news/      # Yahoo Finance news
│   └── migrations/                # Database migrations
└── _bmad-output/                  # BMAD planning artifacts
```

## Available Scripts

```bash
npm run dev      # Start development server
npm run build    # Build for production (tsc + vite)
npm run preview  # Preview production build
npm run lint     # Run ESLint
```

## How AI Signals Work

### Portfolio AI (per-stock on My Portfolio)

1. **Trigger Detection** — Client checks if a stock has a reason to analyze (price dip, price surge, stop-loss zone, quality dip, etc.) — thresholds vary by risk profile
2. **Smart Stop-Loss** — Stocks in stop-loss territory but green today go to AI for evaluation instead of automatic SELL
3. **AI Analysis** — Triggered stocks sent to Groq 70B with full context (conviction scores, price, news, position data, risk profile)
4. **Buy-on-Dips Philosophy** — AI is instructed to recommend BUY only on quality pullbacks, not on stocks up today
5. **Fallback Pipeline** — If 70B rate-limits → tries Qwen3 32B → retries with backoff
6. **Risk-Keyed Cache** — AI results cached per stock per risk profile in localStorage

### Trading Signals (Day / Swing)

1. **Mode Selection** — User picks Day Trade or Swing Trade; mode persists across sessions
2. **Parallel Data Fetch** — Candle data (Twelve Data) and news (Yahoo Finance) fetched concurrently
3. **Two-Phase AI** — Gemini Sentiment Agent scores news, then Trade Agent generates entry/stop/target
4. **Gemini Key Rotation** — Up to 4 API keys rotated round-robin to handle rate limits
5. **Chart Rendering** — Lightweight Charts v5 with candlesticks + overlay lines for entry, stop, target
6. **Extended History** — Swing charts show ~600 daily candles (2-3 years), day charts show 150 intraday candles

Signals only run on explicit user action — no background API calls.

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
