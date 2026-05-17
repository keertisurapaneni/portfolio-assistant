# Dual IB Account Setup

Reference for running paper and live IB Gateway instances side-by-side with the auto-trader.

---

## 1. Architecture Overview

```
┌─────────────┐     port 4002      ┌────────────────────┐
│ Paper Gateway│◄───────────────────│                    │
│  (IBC)       │                    │    Auto-Trader     │
└─────────────┘                    │  (Node.js process) │
                                   │                    │
┌─────────────┐     port 4001      │  Routes trades per │
│ Live Gateway │◄───────────────────│  mode config       │
│  (IBC)       │                    └────────────────────┘
└─────────────┘
                                   ┌────────────────────┐
                                   │   Frontend (Vercel) │
                                   │  Paper/Live pill    │
                                   │  switcher in header │
                                   └────────────────────┘
```

- **Paper Gateway** — port 4002, managed by IBC, auto-starts on boot
- **Live Gateway** — port 4001, managed by IBC, disabled by default
- **Auto-trader** — connects to both, routes trades based on per-mode routing config
- **Frontend** — Paper/Live pill switcher filters views by account

---

## 2. IBC Configuration Files

All located at `~/ibc/`:

| File | Purpose |
|---|---|
| `config.ini` | Paper account config (`TradingMode=paper`, port 4002) |
| `config-live.ini` | Live account config (`TradingMode=live`, `OverrideTwsApiPort=4001`, `ExistingSessionDetectedAction=secondary`) |
| `gatewaystartmacos.sh` | Paper startup script (`IBC_INI=~/ibc/config.ini`) |
| `gatewaystart-live.sh` | Live startup script (`IBC_INI=~/ibc/config-live.ini`, `TWS_SETTINGS_PATH=~/Jts-live`) |

Logs: `~/ibc/logs/`

---

## 3. LaunchAgents

Located at `~/Library/LaunchAgents/`:

| Plist | Behavior |
|---|---|
| `com.portfolio-assistant.ibc-paper.plist` | Auto-starts on boot, KeepAlive on crash, runs paper Gateway |
| `com.portfolio-assistant.ibc-live.plist` | **Disabled by default** — must be manually enabled |
| `com.portfolio-assistant.auto-trader.plist` | The auto-trader Node.js process |

---

## 4. Going Live (Step by Step)

1. **Set credentials** — edit `~/ibc/config-live.ini`, set `IbLoginId` and `IbPassword` to live account credentials

2. **Start the live gateway:**
   ```bash
   launchctl load -w ~/Library/LaunchAgents/com.portfolio-assistant.ibc-live.plist
   ```

3. **Approve MFA** on IBKR Mobile app (required for live accounts)

4. **Verify connection** — check logs for successful login:
   ```bash
   tail -50 ~/ibc/logs/ibc-live-stdout.log
   # Look for: "Login has completed"
   ```

5. **Turn off the Live Kill Switch** — in the UI, go to Settings tab

6. **Flip desired modes from PAPER → LIVE** — in Settings → Trading Modules

7. **Monitor** — check Today's Activity tab with the Live pill selected

---

## 5. Stopping Live Trading

**Emergency** — toggle Kill Switch ON in Settings (immediate, blocks all live orders)

**Graceful:**
1. Flip modes back to PAPER in Settings → Trading Modules
2. Stop the gateway:
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.portfolio-assistant.ibc-live.plist
   ```

---

## 6. Changing Live Account Credentials

Edit `~/ibc/config-live.ini`:
```ini
IbLoginId=your_username
IbPassword=your_password
```

Then restart:
```bash
launchctl unload ~/Library/LaunchAgents/com.portfolio-assistant.ibc-live.plist && \
launchctl load -w ~/Library/LaunchAgents/com.portfolio-assistant.ibc-live.plist
```

---

## 7. Maintenance

| Task | Details |
|---|---|
| **Paper Gateway** | Auto-starts on boot, self-heals on crash. Cold restart every Sunday at 8 AM. |
| **Live Gateway** | MFA required roughly once per week (Sunday cold restart). Approve via IBKR Mobile app. |
| **IB Gateway updates** | Update `TWS_MAJOR_VRSN` in both startup scripts when upgrading IB Gateway. |

---

## 8. Troubleshooting

| Problem | Fix |
|---|---|
| Gateway won't start | Check `~/ibc/logs/` for error details |
| "Existing session detected" | Paper uses `primaryoverride`, live uses `secondary` — live won't kick out paper |
| Auto-trader can't connect | Verify gateway is running: `launchctl list \| grep ibc`. Check port is correct. |
| MFA timeout | IBC auto-retries login (`ReloginAfterSecondFactorAuthenticationTimeout=yes`) |

---

## 9. Mode Routing Reference

In Settings → Trading Modules, each mode can be:

| Setting | Behavior |
|---|---|
| **OFF** | Scanner doesn't run for this mode |
| **PAPER** | Trades route to paper account (port 4002) |
| **LIVE** | Trades route to live account (port 4001) |
| **BOTH** | Trades execute on both accounts (paper always, live best-effort) |

---

## 10. Safety Features

| Feature | Description | Default |
|---|---|---|
| **Live Kill Switch** | Blocks ALL live orders when ON | ON |
| **Daily Loss Limit** | Auto-engages kill switch if live losses exceed threshold | — |
| **Max Positions** | Separate limit for live account | 2 |
| **Position Size** | Separate smaller size for live | $500 |
| **Daily Deployment Limit** | Max new capital per day on live | $5,000 |
