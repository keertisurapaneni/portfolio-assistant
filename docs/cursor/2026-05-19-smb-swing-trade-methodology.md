# SMB Capital Swing Trade Methodology (Ryan Assan)

**Source**: SMB Capital YouTube — "Ultimate Swing Trading Guide" (Ryan Assan, Senior Prop Trader)
**Applied**: 2026-05-19 — Incorporated into `SWING_TRADE_SYSTEM`, `SWING_TRADE_RULES`, and `SWING_SCAN_USER` prompts.

## Three Core Setups

### 1. Consolidation Breakout (Long or Short)
- Multi-day/week tight range near clear S/R level
- **Rubber band effect**: longer consolidation + volume contraction → greater expansion on break
- Stock above key SMAs (200, 50) for long; below for short
- Elevated RVOL (≥ 1.5x) on the breakout day confirms the move
- Stop: just below breakout level (re-entry into range = failed breakout)
- Examples: NVDA at $500 resistance, MSFT at $376, AFRM at $27

### 2. Mean Reversion / Backside Short
- Stock extended significantly from key SMAs / multi-day VWAP
- Blow-off top confirmed by extreme volume + tail candle
- Short entry: lower high into the "supply zone" (heaviest volume area from blow-off day)
- Long entry: quality stock at RSI < 30 — oversold bounce
- Stop: above the recent high (shorts) or below the recent low (longs)
- Target: prior breakout level or key SMA support
- Example: Safety Shot (SHOT) — ran up, topped out, lower high into 550-650 supply zone

### 3. Day-2+ Continuation
- Day 1: massive directional move on fundamentally changing catalyst, close near high/low
- Day 2: pullback to Day 1 support levels + 2-day anchored VWAP
- Entry on the bounce when it holds key Day 1 levels
- Works especially well during earnings season
- Example: SMCI — pre-announced strong figures, Day 2 pullback to $410 (2-day VWAP)

## Qualifying Variables (All Setups)
1. **Clear S/R**: Level tested multiple times over days/weeks/months
2. **Rubber band effect**: Price + volume contraction preceding setup
3. **Clear risk level**: Specific price where thesis is invalidated
4. **Relative strength/weakness**: vs sector, vs SPY
5. **Multiple timeframe alignment**: Daily → Hourly → 5min
6. **Trend alignment**: Key SMAs supporting direction
7. **RVOL ≥ 1.5x on entry day** (low volume during consolidation = positive)
8. **Skewed R:R**: Minimum 3:1 (risk $1 to make $3)

## Position Management
- **Targets**: Use ATR — first target = 1-1.5x ATR. If abnormal volume, stretch to 2x ATR.
- **Scaling**: Take 1/3 off at Target 1, trail remaining with higher lows (longs) / lower highs (shorts) on hourly chart.
- **Trail stop**: Using higher low approach on same timeframe as entry.
- **Exit**: When stock makes first lower low (longs) or higher high (shorts) relative to trail.
- **Alternative trails**: Anchored VWAP from breakout day, or 5-day EMA/SMA.

## Key Indicators
- **VWAP**: Most important — gauge sentiment, entries/exits
- **SMAs**: 5, 20, 50, 200 on daily chart
- **RVOL**: Minimum 1.5x on breakout/entry day
- **ATR**: For target sizing and stop placement
- **RSI**: Extreme readings for mean reversion

## Volume Interpretation (Critical Difference from Day Trading)
- Low volume during consolidation = energy building (rubber band coiling) → **POSITIVE**
- Low volume on pullback = selling pressure drying up → **POSITIVE**
- Volume confirmation matters on **breakout/entry day**, NOT screening day
- Never penalize consolidating stocks for low current volume
