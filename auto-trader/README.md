# Auto-Trader Setup and Operations

This service connects the Portfolio Assistant website to Interactive Brokers paper trading through IB Gateway.

For overall project context, see the main repo guide:
- [Portfolio Assistant main README](../README.md)

Flow:
- Website: `https://portfolioassistant.org/paper-trading`
- Local API: `http://localhost:3001`
- IB Gateway API port: `4002`

## Fast Setup (recommended)

From your cloned repo root, run:

```bash
cd portfolio-assistant/auto-trader
./setup-auto-trader.sh
```

What it does:
- Prompts for IB paper username/password and updates `~/ibc/config.ini`
- Runs `npm install` and `npm run build`
- Installs/reloads `~/Library/LaunchAgents/com.portfolio-assistant.auto-trader.plist`
- Starts services and verifies:
  - port `3001`
  - port `4002`
  - `http://localhost:3001/health`
  - `http://localhost:3001/api/status`

After script success:
1. Open `https://portfolioassistant.org/paper-trading`
2. Sign in
3. Click `Enable Auto-Trading`
4. Click `Sync` if needed

## Prerequisites

- macOS
- Node.js 22.x (`node`, `npm`)
- IB Gateway installed (10.x)
  - Download and install: [IB Gateway stable download](https://www.interactivebrokers.com/en/trading/ibgateway-stable.php)
- IBC installed at `~/ibc` (skip if already present)
  - Required files:
    - `~/ibc/gatewaystartmacos.sh`
    - `~/ibc/config.ini`

If `~/ibc` exists but scripts are not executable:

```bash
chmod +x ~/ibc/gatewaystartmacos.sh ~/ibc/scripts/*.sh
```

## Environment File

Create `.env` from `.env.example` before running the service:

```bash
cd portfolio-assistant/auto-trader
cp .env.example .env
```

Expected keys:
- `IB_HOST` (default `127.0.0.1`)
- `IB_PORT` (default `4002`)
- `IB_CLIENT_ID` (default `1`)
- `PORT` (default `3001`)

## Manual Fallback (if script is not used)

1. Configure IBC credentials:

```bash
cp portfolio-assistant/auto-trader/ibc/config.ini.example ~/ibc/config.ini
# then edit IbLoginId / IbPassword in ~/ibc/config.ini
```

2. Build and run:

```bash
cd portfolio-assistant/auto-trader
npm install
npm run build
./start.sh
```

## Troubleshooting

- Check listeners:

```bash
lsof -nP -iTCP:3001 -sTCP:LISTEN
lsof -nP -iTCP:4002 -sTCP:LISTEN
```

- Restart launcher:

```bash
launchctl kickstart -k gui/$(id -u)/com.portfolio-assistant.auto-trader
```

- Logs:
  - `/tmp/auto-trader-stdout.log`
  - `/tmp/auto-trader-stderr.log`
  - `~/ibc/logs/`

## External Strategy Signals (Source Tracking)

The auto-trader now supports source-attributed, date-based signals (for example from specific pages/creators):

- `POST /api/strategy-signals` — queue a signal
- `GET /api/strategy-signals` — list queued/executed signals
- `PATCH /api/strategy-signals/:id` — update/cancel a signal
- `GET /api/strategy-performance` — P&L leaderboard by source

Minimum payload for `POST /api/strategy-signals`:

```json
{
  "sourceName": "Example Trading Page",
  "sourceUrl": "https://instagram.com/example",
  "ticker": "AAPL",
  "signal": "BUY",
  "mode": "SWING_TRADE",
  "executeOnDate": "2026-02-19"
}
```

## Security notes

- Never commit real credentials.
- Keep real credentials only in `~/ibc/config.ini`.
- Use `TradingMode=paper` unless explicitly switching to live.
