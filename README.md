# Portfolio Assistant

AI-powered stock signals — skip the noise, catch the plays.

A personal investing decision-support tool that combines automated conviction scoring with AI trade signals (Groq Llama 3.3 70B) to help you know when to buy, sell, or sit tight.

## Features

### My Portfolio

- **Conviction Scoring** — Automated 0-100 score based on 4 factors: Quality (30%), Earnings (30%), Analyst (25%), Momentum (15%)
- **AI Trade Signals** — BUY/SELL recommendations powered by Groq's Llama 3.3 70B with risk-adjusted guardrails
- **Portfolio Values** — Per-stock position value and total portfolio with daily P&L
- **Risk Warnings** — Concentration, stop-loss, profit-taking, and overconcentration alerts
- **News Headlines** — Latest company-specific news on each card with clickable links
- **Portfolio Import** — CSV/Excel upload with smart column detection (ticker, shares, avg cost)

### Market Movers

- Top 25 gainers and losers from Yahoo Finance
- Sortable columns (Price, Change, Change %)

### Suggested Finds

- Curated "Quiet Compounders" and "Gold Mines" with expandable investment theses
- One-click add to portfolio

### Risk Profile Settings

- **Aggressive** — -4% stop-loss, +25% profit-take, 30% max position
- **Moderate** — -7% stop-loss, +20% profit-take, 25% max position
- **Conservative** — -5% stop-loss, +20% profit-take, 20% max position

## Tech Stack

- **Frontend:** React 18 + TypeScript + Vite + Tailwind CSS 4
- **AI:** Groq (Llama 3.3 70B + Qwen3 32B fallback) via Supabase Edge Function
- **Data:** Finnhub API (quotes, metrics, recommendations, earnings, news)
- **Backend:** Supabase (Edge Functions + PostgreSQL cache)
- **Deployment:** Vercel (frontend) + Supabase (backend)

## Architecture

```
Browser → Supabase Edge Functions → External APIs
                                     ├── Groq (AI trade signals)
                                     ├── Finnhub (stock data)
                                     └── Yahoo Finance (market movers, news)
```

**Edge Functions:**
| Function | Purpose |
|---|---|
| `fetch-stock-data` | Proxies Finnhub API with 15-min server cache |
| `ai-proxy` | AI proxy with 70B/32B fallback pipeline |
| `scrape-market-movers` | Yahoo Finance screener for gainers/losers |
| `fetch-yahoo-news` | Company-specific news from Yahoo Finance |

**API keys never touch the browser** — all sensitive keys stored as Supabase secrets.

## Quick Start

### Prerequisites

- Node.js 18+ (LTS recommended)
- Supabase account + CLI
- Finnhub API key (free: https://finnhub.io/register)
- Groq API key (free: https://console.groq.com)

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
supabase functions deploy scrape-market-movers --no-verify-jwt
supabase functions deploy fetch-yahoo-news --no-verify-jwt

# Frontend auto-deploys to Vercel on git push to master
git push origin master
```

## Project Structure

```
portfolio-assistant/
├── app/                          # React frontend
│   ├── src/
│   │   ├── components/           # UI components
│   │   │   ├── Dashboard.tsx     # Portfolio overview + total value
│   │   │   ├── StockCard.tsx     # Individual stock card
│   │   │   ├── StockDetail.tsx   # Slide-over detail panel
│   │   │   ├── MarketMovers.tsx  # Gainers/losers tables
│   │   │   ├── SuggestedFinds.tsx
│   │   │   ├── SettingsModal.tsx # Risk profile settings
│   │   │   ├── AddTickersModal.tsx
│   │   │   └── ImportPortfolioModal.tsx
│   │   ├── lib/                  # Business logic
│   │   │   ├── aiInsights.ts     # AI trade signals + caching
│   │   │   ├── convictionEngine.ts # 4-factor scoring engine
│   │   │   ├── stockApiEdge.ts   # Finnhub API integration
│   │   │   ├── portfolioCalc.ts  # Portfolio weight calculations
│   │   │   ├── warnings.ts      # Risk warning system
│   │   │   ├── settingsStorage.ts # Risk profile + drawdown
│   │   │   ├── storage.ts       # localStorage CRUD
│   │   │   ├── importParser.ts  # CSV/Excel parsing
│   │   │   └── utils.ts         # Tailwind helpers
│   │   ├── types/index.ts       # TypeScript types
│   │   └── App.tsx              # Main app + AI orchestration
│   └── .env.example
├── supabase/functions/           # Edge Functions
│   ├── fetch-stock-data/         # Finnhub proxy + cache
│   ├── ai-proxy/                 # AI proxy (Groq 70B/32B)
│   ├── scrape-market-movers/     # Yahoo Finance screener
│   └── fetch-yahoo-news/         # Yahoo Finance news
├── docs/                         # Documentation
│   ├── AI-BUY-PRIORITY-SYSTEM.md # AI signal system docs
│   ├── DEPLOY_MARKET_MOVERS.md
│   ├── DEPLOY_YAHOO_NEWS.md
│   ├── GET_SUPABASE_KEYS.md
│   └── verify-code-consistency.md
└── _bmad-output/                 # BMAD planning artifacts
    └── planning-artifacts/
        ├── prd.md                # Product Requirements Document
        ├── epics.md              # Epic & story breakdown
        ├── architecture.md       # Architecture decisions
        └── ux-design-specification.md
```

## Available Scripts

```bash
npm run dev      # Start development server
npm run build    # Build for production (tsc + vite)
npm run preview  # Preview production build
npm run lint     # Run ESLint
```

## How AI Signals Work

1. **Trigger Detection** — Client checks if a stock has a reason to analyze (price move, stop-loss zone, earnings news, etc.)
2. **Mechanical Guardrails** — Hard SELL for stop-loss, profit-taking, overconcentration (risk-profile adjusted)
3. **AI Analysis** — Remaining stocks sent to Groq 70B via Edge Function with full context (scores, price, news, position data)
4. **Fallback Pipeline** — If 70B rate-limits → tries 32B → retries after 3s → client retries after 10s
5. **Display** — BUY/SELL badge on main card + full reasoning in detail view (always in sync)

Signals only run on explicit refresh — no background API calls.

## Troubleshooting

| Issue              | Fix                                                                       |
| ------------------ | ------------------------------------------------------------------------- |
| Port 5173 in use   | `lsof -ti:5173 \| xargs kill -9`                                          |
| .env not loading   | Must be in `app/` directory, vars need `VITE_` prefix, restart dev server |
| 429 rate limits    | Wait 15s (auto-cooldown), or reduce portfolio size                        |
| AI signals missing | Hit refresh — signals don't load from cache on page load                  |
| Build errors       | `rm -rf node_modules && npm install` then `npm run build`                 |

## License

Personal project — not for redistribution.
