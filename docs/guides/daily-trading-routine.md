# Daily Trading Routine

## Schedule (all times Eastern)

### Pre-Market (7:00 - 9:25 AM)
- **Pre-market gap scanner** runs automatically
- Scans DAY_CORE tickers + portfolio holdings via Yahoo Finance
- Caches gappers (>1.5% move vs previous close) for market open injection
- No IB connection needed — data collection only

### 8:00 AM ET — Morning Brief (cloud, no laptop needed)
- **Morning Brief** generated automatically via Supabase Edge Function + pg_cron
- Fetches: Finnhub market news (last 12h), today's earnings, economic calendar events
- AI (Llama 70B) synthesizes into structured brief: macro snapshot, top movers, economic calendar, research themes
- Viewable at the **Morning Brief** tab in the app
- Can also be triggered manually anytime via the "Generate Now" button in the app

### Before Market Open
- **Log into IB Gateway by 9:15-9:20 AM** — the auto-trader checks `authenticated && connected` before placing any orders
- Verify the auto-trader service is running (Node.js auto-trader server)
- **Suggested Finds generate automatically** at 9:00 AM ET server-side — no browser visit needed

### Market Open (9:30 AM)
- **First day trade scan** fires — Yahoo movers + DAY_CORE + pre-market gappers
- Pass 1 (batch AI screen) → Pass 2 (FA-grade analysis per ticker)
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

### Options Wheel Scan Windows (10:00 AM – 3:30 PM)
The options scanner runs throughout the full trading day:

| Session | Window | Cadence |
|---------|--------|---------|
| Morning | 10:00–11:30 AM | Every 15 min |
| Midday | 11:30 AM–2:00 PM | Every 30 min |
| Afternoon | 2:00–3:30 PM | Every 30 min |

**Daily cap:** Max 3 new puts per day. The scanner also manages existing positions (rolls, closes, covered call placement) every 15 min throughout the day.

### Day Trade Management (continuous)
The auto-trader actively manages all open day trades:

| Feature | Trigger | Action |
|---------|---------|--------|
| **Trailing stop** | Position moves in our favor | Stop-loss adjusts upward to lock in profit |
| **Daily max-loss gate** | Realized day-trade losses exceed $500 | No new day trade entries for the rest of the day |
| **3:45 PM soft close** | 3:45 PM ET | Closes losing day trades and near-target winners before power-hour chaos |
| **3:55 PM hard close** | 3:55 PM ET | Hard backstop — closes all remaining day trades via market order |
| **Stale detector** | Overnight scan at open | Detects and closes any prior-day open day trades that weren't caught |

### End of Day (3:55 PM)
- **Day trade auto-close** fires — all open day trades closed via market order
- Prevents overnight holds on intraday positions

### After Hours (4:00 PM+)
- No new scans triggered
- Cached results served until next trading day

---

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
- **FA says HOLD** → trade is skipped
- **FA disagrees on direction** → FA's direction is used (deeper data = more reliable)
- **FA fails (network/rate limit)** → falls back to scanner Pass 2 levels if available

---

## Settings to Check

| Setting | Default | Notes |
|---------|---------|-------|
| Min Scanner Confidence | 6 | Scanner Pass 2 output threshold |
| Min FA Confidence | 6 | Full Analysis confidence threshold |
| Suggested Finds Min Conviction | 8 | For long-term auto-buys |
| Max Concurrent Positions | 3 | Increase for more exposure |
| Day Trade Auto-Close | ON | Closes all day trades at 3:55 PM ET |
| Day Trade Max Daily Loss | $500 | Gate stops new entries after this realized loss |
| Options Auto-Trade | ON | Scanner places real IB paper orders |
| Options Max New Per Day | 3 | Daily cap on new put positions |

---

## Troubleshooting

### No trades firing
1. Check IB Gateway is connected (auto-trader logs will show "IB Gateway not connected")
2. Check `auto_trade_events` table for skip reasons
3. Common blockers: "SPY below SMA200", "Critical drawdown", allocation cap reached
4. Scanner producing 0 results → may need `forceRefresh` or market may genuinely have no setups

### Scanner returning empty
- Day trades: only scan during market hours (9:30-4:00 PM ET)
- Swing trades: only scan during 4 refresh windows
- Options: scans 10 AM–3:30 PM; check daily cap (max 3 new puts/day)
- Check Gemini API keys are valid (diagnostics mode: `POST /trade-scanner` with `{ "_diagnostics": true }`)

### Morning Brief is empty
- Runs automatically at 8 AM ET via Supabase pg_cron (cloud — no laptop needed)
- Can be generated anytime via "Generate Now" button in the Morning Brief tab
- Requires FINNHUB_API_KEY and GROQ_API_KEY configured in Supabase Edge Function secrets
