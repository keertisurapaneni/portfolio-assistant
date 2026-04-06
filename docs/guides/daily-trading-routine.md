# Daily Trading Routine

## Schedule (all times Eastern)

### Pre-Market (7:00 - 9:25 AM)
- **Pre-market gap scanner** runs automatically
- Scans DAY_CORE tickers + portfolio holdings via Yahoo Finance
- Caches gappers (>1.5% move vs previous close) for market open injection
- No IB connection needed — data collection only

### Before Market Open
- **Log into IB Gateway by 9:15-9:20 AM** — the auto-trader checks `authenticated && connected` before placing any orders
- Verify the auto-trader service is running (Node.js auto-trader server)

### Market Open (9:30 AM)
- **First day trade scan** fires — Yahoo movers + DAY_CORE + pre-market gappers
- Pass 1 (batch AI screen) -> Pass 2 (FA-grade analysis per ticker)
- Results cached with 390-min TTL (one scan per day unless forced)
- Auto-trader processes qualified ideas: scanner finds opportunity, Full Analysis confirms direction + provides entry/stop/target levels

### Swing Trade Windows
Swing scans refresh during these windows (only when day scan isn't running):
| Window | Time |
|--------|------|
| Near open | 9:45 - 10:15 AM |
| Midday | 12:00 - 12:30 PM |
| Afternoon | 2:00 - 2:30 PM |
| Near close | 3:30 - 4:00 PM |

### End of Day (3:55 PM)
- **Day trade auto-close** fires — all open day trades closed via market order
- Prevents overnight holds on intraday positions

### After Hours (4:00 PM+)
- No new scans triggered
- Cached results served until next trading day

## Signal Pipeline

```
Scanner Pass 1 (batch, lightweight indicators)
  -> Top candidates (confidence >= 5)
    -> Scanner Pass 2 (FA-grade prompt, entry/stop/target)
      -> Auto-trader receives qualified ideas (confidence >= 6)
        -> Full Analysis (Twelve Data, 3 timeframes, sentiment)
          -> FA direction + levels used for trade execution
            -> Bracket order placed on IB (entry, stop loss, take profit)
```

### Key decision points:
- **Scanner finds the opportunity** — discovers movers, ranks by InPlayScore (day) or SwingSetupScore (swing)
- **Full Analysis confirms direction** — has richer data (150-600 candle bars, 3 timeframes, sentiment analysis)
- **FA says HOLD** -> trade is skipped
- **FA disagrees on direction** -> FA's direction is used (deeper data = more reliable)
- **FA fails (network/rate limit)** -> falls back to scanner Pass 2 levels if available

## Settings to Check

| Setting | Default | Notes |
|---------|---------|-------|
| Min Scanner Confidence | 6 | Scanner Pass 2 output threshold |
| Min FA Confidence | 6 | Full Analysis confidence threshold |
| Suggested Finds Min Conviction | 8 | For long-term auto-buys |
| Max Concurrent Positions | 3 | Increase for more exposure |
| Day Trade Auto-Close | ON | Closes all day trades at 3:55 PM ET |

## Troubleshooting

### No trades firing
1. Check IB Gateway is connected (auto-trader logs will show "IB Gateway not connected")
2. Check `auto_trade_events` table for skip reasons
3. Common blockers: "SPY below SMA200", "Critical drawdown", allocation cap reached
4. Scanner producing 0 results -> may need `forceRefresh` or market may genuinely have no setups

### Scanner returning empty
- Day trades: only scan during market hours (9:30-4:00 PM ET)
- Swing trades: only scan during 4 refresh windows
- Check Gemini API keys are valid (diagnostics mode: `POST /trade-scanner` with `{ "_diagnostics": true }`)
