# Portfolio Assistant

AI-powered stock signals — skip the noise, catch the plays.

**Live:** [portfolioassistant.org](https://portfolioassistant.org)

## What It Does

| Page | Summary |
|---|---|
| **My Portfolio** `/` | Conviction scoring (0-100), AI BUY/SELL signals, risk profiles, brokerage sync (SnapTrade), CSV import, news, daily P&L |
| **Trade Signals** `/signals` | AI scanner finds day/swing setups → full analysis with indicators, scenarios, dual targets, charts, long-term outlook |
| **Suggested Finds** `/finds` | Quiet Compounders (quality + valuation ranked) and Gold Mines (macro-theme opportunities) discovered daily by AI, with "Owned" badge for stocks in portfolio |
| **Paper Trading** `/paper-trading` | Auto-executes high-confidence signals on IB paper account, tracks P&L, AI learns from outcomes |
| **Market Movers** `/movers` | Top 25 gainers/losers from Yahoo Finance |

## Features

### My Portfolio

- **Conviction Score** — 0-100 based on Quality (30%), Earnings (30%), Analyst (25%), Momentum (15%)
- **AI Trade Signals** — BUY/SELL/HOLD per stock via Groq LLM with risk-adjusted guardrails
- **Risk Profiles** — Aggressive / Moderate / Conservative shapes AI buy/sell logic
- **Brokerage Sync** — Schwab, IBKR, Robinhood & [more](https://snaptrade.com/brokerage-integrations) via SnapTrade
- **Auth** — Optional email/password login (Supabase Auth) to save portfolio across devices; guest mode uses localStorage

### Trade Signals

- **Trade Ideas** — AI scanner suggests high-confidence day/swing setups; click any idea to run full analysis
- **Auto Mode** — Picks Day or Swing based on ATR% and ADX volatility (default)
- **Indicator Engine** — RSI, MACD, EMA/SMA, ATR, ADX, volume ratio, support/resistance pre-computed and fed to AI
- **Market Context** — SPY trend + VIX snapshot included in every analysis
- **Scenarios** — Bullish/neutral/bearish with probability estimates and dual price targets
- **Long Term Outlook** — Fundamentals (ROE, P/E, margins, earnings, analyst recs) via Finnhub + Gemini in parallel
- **Charts** — Candlestick with entry/stop/target overlays (2-3 years for swing)

### Suggested Finds

- **Quiet Compounders** — Quality stocks ranked by conviction (1-10), valuation tags (Deep Value → Fully Valued), filterable by industry
- **Gold Mines** — Macro-theme-driven opportunities across the value chain, with conviction scores and valuation tags
- **Top Pick** badge on highest-conviction stock per category
- Powered by HuggingFace (Qwen2.5-72B → Mixtral-8x7B → Llama-3.1-8B cascade), daily server-side cache

### Paper Trading 🔒

*Auth required — connects to IB paper account via IB Gateway + IBC (hands-off, no daily login)*

- **IB Portfolio** — Live positions (shares, cost, P&L, market value) and open orders with bracket grouping
- **Today's Activity** — All trades executed today with ticker, signal, mode, confidence, and time
- **Trade History** — Completed trades with entry/close price and P&L
- **Auto-Trade** — Scanner ideas execute as bracket orders (entry + stop + target); Suggested Finds execute as market buys (long-term holds, no stop/target)
- **AI Feedback Loop** — Analyzes wins/losses, stores lessons, identifies patterns
- **Performance Stats** — Win rate, total P&L, avg P&L per trade
- **Settings** — Toggle auto-trading, configure position size, confidence thresholds; persists via Supabase

#### Auto-Trade Filters

| Source | Auto-Buy Condition |
|---|---|
| **Trade Signals (scanner)** | Trade idea confidence 7+ AND full analysis confidence 7+ |
| **Trade Signals (manual)** | Full analysis confidence 7+ with BUY/SELL → prompts user |
| **Suggested Finds** | Conviction 8+ (any valuation) |
| **Suggested Finds** | Conviction 7 + "Undervalued" or "Deep Value" |

## Architecture

```
Browser (React 19 · Vite 7 · TypeScript 5.9 · Tailwind CSS 4)
│
│  Routes: /  /signals  /finds  /movers  /paper-trading
│  Auth: Supabase (email/password, optional)
│  Deploy: Vercel (auto on push to master)
│  DNS: Squarespace → portfolioassistant.org
│
├─► Supabase Edge Functions (Deno)
│   ├ ai-proxy ──────────── Groq API (Llama 3.3 70B)
│   ├ fetch-stock-data ──── Finnhub API
│   ├ trading-signals ───── Yahoo Finance + Finnhub + Gemini (13 keys, rotated)
│   ├ trade-scanner ─────── Yahoo screener + Gemini (two-pass)
│   ├ huggingface-proxy ─── HuggingFace Inference API
│   ├ daily-suggestions ─── HuggingFace (cached daily)
│   ├ broker-connect/sync ─ SnapTrade API
│   ├ scrape-market-movers ─ Yahoo Finance
│   └ fetch-yahoo-news ──── Yahoo Finance
│
├─► Supabase PostgreSQL (RLS)
│   ├ portfolios          ├ trade_scans
│   ├ broker_connections  ├ daily_suggestions
│   ├ user_settings       ├ paper_trades (DAY_TRADE/SWING_TRADE/LONG_TERM)
│   ├ auto_trade_events   ├ trade_learnings
│   ├ auto_trader_config  ├ trade_performance
│   ├ portfolio_snapshots └ (guest: localStorage)
│
└─► auto-trader/ (local Node.js service, port 3001)
    ├ @stoqey/ib → IB Gateway (port 4002)
    └ IBC auto-login (hands-off)
```

### AI Layers

| Layer | Model | What It Does |
|---|---|---|
| Conviction Scoring | Rule-based | 0-100 score from Finnhub metrics, earnings, recommendations |
| Portfolio Signals | Groq (Llama 3.3 70B) | BUY/SELL per stock using fundamentals + news + risk profile |
| Trade Ideas | Gemini (rotated) | Scan market → filter top setups with indicator engine |
| Trade Signals | Gemini (rotated) | Full analysis: indicators, scenarios, targets, long-term outlook |
| Quiet Compounders | HuggingFace (Qwen2.5-72B) | Discover quality stocks, rank by conviction + valuation |
| Gold Mines | HuggingFace (Qwen2.5-72B) | Macro-theme opportunities from news + fundamentals |
| Paper Trading | Gemini (via scanner + FA) | Auto-execute signals → IB bracket orders |
| AI Feedback Loop | Heuristic | Analyze trade outcomes → pattern recognition |

**API keys never touch the browser** — all sensitive keys stored as Supabase secrets. Edge function details: [`supabase/functions/README.md`](supabase/functions/README.md).

## Quick Start

### Prerequisites

- Node.js 22+ (`nvm install 22` — required by Vite 7)
- [Supabase](https://supabase.com) account + CLI (Auth enabled, confirm email OFF)
- API keys: [Finnhub](https://finnhub.io/register) · [Groq](https://console.groq.com) · [Gemini](https://aistudio.google.com/apikey) · [HuggingFace](https://huggingface.co/settings/tokens) · [Twelve Data](https://twelvedata.com/account/api-keys) · [SnapTrade](https://snaptrade.com) (optional)

### Setup

```bash
git clone <repo-url>
cd portfolio-assistant/app
npm install
cp .env.example .env   # add your Supabase URL + anon key
npm run dev             # http://localhost:5173
```

### Environment

| Variable | Source |
|---|---|
| `VITE_SUPABASE_URL` | Supabase Dashboard → Settings → API |
| `VITE_SUPABASE_ANON_KEY` | Supabase Dashboard → Settings → API |

All other keys are **Supabase secrets** (never in `.env`):

```bash
supabase secrets set FINNHUB_API_KEY=<key>
supabase secrets set GROQ_API_KEY=<key>
supabase secrets set GEMINI_API_KEY=<key>          # add _2, _3, … _13 for rotation
supabase secrets set TWELVE_DATA_API_KEY=<key>
supabase secrets set HUGGINGFACE_API_KEY=<key>
supabase secrets set SNAPTRADE_CLIENT_ID=<id>      # optional
supabase secrets set SNAPTRADE_CONSUMER_KEY=<key>  # optional
```

### Deploy

```bash
supabase functions deploy --no-verify-jwt   # edge functions
supabase db push                            # database migrations
git push origin master                      # frontend auto-deploys to Vercel
```

## Scripts

```bash
npm run dev      # dev server
npm run build    # production build (tsc + vite)
npm run preview  # preview production build
npm run lint     # ESLint
```

## Docs

| Doc | Description |
|---|---|
| [`docs/DAY-TRADE-PROMPTS-SEQUENCE.md`](docs/DAY-TRADE-PROMPTS-SEQUENCE.md) | Day trade scanner + FA prompt flow |
| [`docs/SWING-TRADE-PROMPTS-SEQUENCE.md`](docs/SWING-TRADE-PROMPTS-SEQUENCE.md) | Swing trade scanner + FA prompt flow |
| [`docs/DAY-TRADE-VALIDATION-QUERIES.md`](docs/DAY-TRADE-VALIDATION-QUERIES.md) | Day trade performance analysis queries |
| [`docs/SWING-TRADE-VALIDATION-QUERIES.md`](docs/SWING-TRADE-VALIDATION-QUERIES.md) | Swing funnel + diagnostics (UI: Paper Trading → Validation → Swing) |
| [`docs/INSTAGRAM-STRATEGY-ARCHITECTURE.md`](docs/INSTAGRAM-STRATEGY-ARCHITECTURE.md) | External strategy signals from videos |
| [`supabase/functions/README.md`](supabase/functions/README.md) | Edge functions, prompts, API keys |
| [`auto-trader/README.md`](auto-trader/README.md) | IB Gateway setup, scheduler |

## Commit Conventions

Vercel deploys on push to `master`, **except**:

| Prefix | Use for | Deploys? |
|---|---|---|
| `feat:` | New features | Yes |
| `fix:` | Bug fixes | Yes |
| `docs:` | README, docs/, comments, prompts | No |
| `chore:` | Dependencies, config, tooling | No |
| `ci:` | CI/CD, workflows | No |

Example: `docs: add swing validation queries`

## Troubleshooting

| Issue | Fix |
|---|---|
| Port 5173 in use | `lsof -ti:5173 \| xargs kill -9` |
| .env not loading | Must be in `app/`, vars need `VITE_` prefix, restart dev server |
| 429 rate limits | Wait 15s (auto-cooldown) or reduce portfolio size |
| Build errors | `rm -rf node_modules && npm install && npm run build` |
| IB disconnected | Restart IB Gateway: `~/ibc/gatewaystartmacos.sh` |

## License

Personal project — not for redistribution.
