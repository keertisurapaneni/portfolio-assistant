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

- **Trade Ideas** — AI scanner suggests high-confidence day and swing trade setups with BUY/SELL signals and confidence scores; click any idea to run a full analysis
- **Auto Mode** — Automatically picks Day or Swing based on ATR% and ADX volatility analysis (default)
- **Day Trade** — Intraday signals (1m/15m/1h timeframes) with technical indicators
- **Swing Trade** — Multi-day/week signals (4h/1d/1w timeframes) with technical indicators
- **Technical Indicator Engine** — Pre-computed RSI, MACD, EMA/SMA, ATR, ADX, volume ratio, support/resistance fed to AI
- **Market Context** — SPY trend + VIX volatility snapshot included in every analysis
- **Scenario Analysis** — Bullish/neutral/bearish scenarios with probability estimates
- **Confidence Score** — 0-10 visual confidence rating with dual price targets
- **Long Term Outlook** — Fundamental analysis section (ROE, P/E, margins, earnings, analyst recs) that appears in all modes — powered by Finnhub + Gemini running in parallel with zero added latency
- **Interactive Charts** — Candlestick charts with entry/stop/target overlays (2-3 years of history for swing)
- Powered by Gemini (multi-key rotation) + Twelve Data (candles + indicators) + Yahoo Finance (news + screener) + Finnhub (fundamentals)

### Suggested Finds (`/finds`)

- **Quiet Compounders** — AI-discovered quality stocks ranked by buy conviction, with valuation assessment
  - **Conviction Score** (1-10) — How strongly the AI recommends buying NOW, based on business quality + valuation
  - **Valuation Tags** — "Deep Value", "Undervalued", "Fair Value", "Fully Valued" based on P/E-to-growth
  - **Industry Categories** — Each stock tagged with its industry (HVAC, Distribution, Waste Management, etc.)
  - **Category Dropdown** — Filter by industry or discover new stocks in a specific category
  - **Top Pick** — Highest conviction stock highlighted with special badge
- **Gold Mines** — Macro-theme-driven opportunities diversified across the value chain, with conviction scores and valuation tags
- Powered by HuggingFace Inference API with model cascade (Qwen2.5-72B → Mixtral-8x7B → Llama-3.1-8B)
- Server-side daily cache per category — same picks for everyone each day, saves AI tokens

### Paper Trading (`/paper-trading`) 🔒

*Requires authentication — connects to Interactive Brokers paper account via IB Gateway + IBC (hands-off, no daily login)*

#### What It Does

| Feature | Description |
|---|---|
| **IB Portfolio** | Live view of all IB positions (shares, avg cost, cost basis, market value, P&L) and open/working orders with bracket order grouping |
| **Auto-Trade: Scanner** | Scanner ideas that pass the filter below automatically run full analysis → bracket order on IB |
| **Auto-Trade: Suggested Finds** | Quiet Compounders and Gold Mines that pass the filter below auto-buy as swing trades (GTC) |
| **Manual Trade Prompt** | Research any ticker → if FA confidence 7+ and BUY/SELL, prompts to execute on IB |
| **Bracket Orders** | Every trade placed with entry + stop-loss + take-profit via TWS API |
| **Position Sync** | Active positions, fill prices, P&L synced from IB to Supabase |
| **AI Feedback Loop** | Analyzes completed trades (wins/losses), stores lessons, identifies winning/losing patterns |
| **Performance Dashboard** | Win rate, total P&L, best/worst trades, pattern analysis |
| **Enable/Disable Toggle** | Turn auto-trading on/off anytime; persists across sessions (localStorage) |
| **Activity Log** | Live event stream of auto-trader actions |

#### Auto-Trade Filters

| Source | Condition | Auto-Buy? |
|---|---|---|
| **Scanner Ideas** | Scanner confidence 7+ AND FA confidence 7+ | Yes |
| **Scanner Ideas** | Scanner or FA confidence below 7 | No |
| **Suggested Finds** | Conviction 8+ (any valuation) | Yes |
| **Suggested Finds** | Conviction 7 + "Undervalued" or "Deep Value" | Yes |
| **Suggested Finds** | Conviction 7 + "Fair Value" or "Fully Valued" | No |
| **Suggested Finds** | Conviction 6 or below | No |

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
│  Client-side routing: / , /signals , /finds , /movers , /paper-trading │
│          Supabase Auth (optional email/password login)              │
└──────┬────────────┬────────────────────┬──────────┬─────────────────┘
       │            │                    │          │
       │ Portfolio  │ Trade Signals      │ Finds    │ Paper Trading
       │ AI         │                    │          │ (auth-only)
┌──────▼─────────┐ ┌▼──────────────────┐ ┌▼───────┐ ┌▼───────────────┐
│ Supabase Edge  │ │ Supabase Edge     │ │ Edge   │ │ auto-trader/   │
│ Functions      │ │ Functions         │ │ Funcs  │ │ (local Node.js │
│                │ │                   │ │        │ │  service)      │
│ ai-proxy       │ │ trading-signals   │ │ hf-    │ │ @stoqey/ib     │
│ └─ Groq API    │ │ ├─ Yahoo Finance  │ │ proxy  │ │ → IB Gateway   │
│                │ │ ├─ Finnhub        │ │        │ │   (port 4002)  │
│ fetch-stock-   │ │ └─ Gemini (13     │ │ daily- │ │                │
│ data           │ │    keys, rotated) │ │ sugg.  │ │ IBC auto-login │
│ └─ Finnhub API │ │                   │ │        │ │ (hands-off)    │
│                │ │ trade-scanner     │ │        │ └────────────────┘
│ broker-connect │ │ └─ Yahoo + Gemini │ │        │
│ broker-sync    │ │                   │ │        │
│ └─ SnapTrade   │ └───────────────────┘ └────────┘
│                │
│ scrape-market- │   ┌─────────────────────────────────────────────┐
│ movers         │   │  Supabase PostgreSQL (RLS)                  │
│ fetch-yahoo-   │   │  ├─ portfolios (user holdings)              │
│ news           │   │  ├─ broker_connections (SnapTrade creds)    │
│ └─ Yahoo       │   │  ├─ user_settings (risk profile)            │
│    Finance     │   │  ├─ trade_scans (scanner results cache)     │
└────────────────┘   │  ├─ daily_suggestions (shared AI cache)     │
                     │  ├─ paper_trades (auto-executed trades)     │
                     │  ├─ trade_learnings (AI feedback per trade) │
                     │  └─ trade_performance (aggregate stats)     │
                     └─────────────────────────────────────────────┘

                     ┌─────────────────────────────────────────────┐
                     │  Storage Strategy                           │
                     │  Guest: localStorage (browser-only)         │
                     │  Authed: Supabase PostgreSQL (cloud)        │
                     │         + localStorage (market data cache)  │
                     └─────────────────────────────────────────────┘
```

### How the AI Layers Work

| Layer | Purpose | AI Model | Data Sources |
|---|---|---|---|
| **Conviction Scoring** | Automated 0-100 score per stock | None (rule-based) | Finnhub metrics, earnings, recommendations |
| **Portfolio Trade Signals** | BUY / SELL / no-action per stock | Groq (Llama 3.3 70B) | Finnhub data + market news + risk profile |
| **Trade Ideas** | Scan market for high-confidence day/swing setups | Gemini (multi-key rotation) | Yahoo Finance screener + candles → Indicator Engine + Gemini two-pass evaluation |
| **Trade Signals** | Auto/Day/Swing trade with indicators, scenarios, dual targets + Long Term Outlook | Gemini (multi-key rotation) | Twelve Data candles → Indicator Engine (RSI, MACD, EMA, ATR, ADX) + Yahoo Finance news + SPY/VIX market context + Finnhub fundamentals |
| **Quiet Compounders** | Discover quality stocks ranked by conviction, with valuation tags and category filtering | HuggingFace (Qwen2.5-72B) | Finnhub metrics |
| **Gold Mines** | Macro-theme-driven opportunities | HuggingFace (Qwen2.5-72B) | Market news + Finnhub fundamentals |
| **Paper Trading** | Auto-execute high-confidence signals, track P&L | Gemini (via scanner + FA) | Scanner results + full analysis → IB Gateway bracket orders |
| **AI Feedback Loop** | Analyze trade outcomes, learn from wins/losses | Heuristic (rule-based) | paper_trades + trade_learnings → pattern recognition |

**API keys never touch the browser** — all sensitive keys stored as Supabase secrets. Edge function details are in [`supabase/functions/README.md`](supabase/functions/README.md).

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
