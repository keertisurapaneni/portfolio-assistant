# Trade Signals — Indicator Engine & Analysis Pipeline

Internal reference for how the Trade Signals feature analyzes a stock.

---

## Overview

When a user requests a trade signal, we run a multi-step pipeline:

1. **Fetch candle data** from Twelve Data (3 timeframes per mode)
2. **Compute technical indicators** from the candles (pure math, no external deps)
3. **Fetch market context** (SPY trend + VIX volatility)
4. **Fetch news headlines** from Yahoo Finance
5. **Build an enriched AI prompt** with pre-computed indicators as the primary input
6. **Run two parallel Gemini agents** — sentiment analysis + trade analysis
7. **Return structured response** with signal, indicators, scenarios, and chart data

---

## Mode Selection

| Mode | Timeframes | Use Case |
|------|-----------|----------|
| **Auto** | Fetches daily candles first, then picks Day or Swing | Default — best for most users |
| **Day Trade** | 1m (entry), 15m (structure), 1h (trend) | Intraday setups |
| **Swing Trade** | 4h (setup), 1d (trend), 1w (macro) | Multi-day/week positions |

### Auto Mode Detection Logic

Auto mode fetches 60 daily candles and computes:
- **ATR as % of price**: `ATR(14) / currentPrice * 100`
- **ADX(14)** for trend strength

Decision:
- `ATR% > 2%` AND `ADX > 20` → **Day Trade** (high intraday volatility)
- Otherwise → **Swing Trade** (lower volatility favors multi-day holds)

---

## Technical Indicators Computed

All computed in `supabase/functions/trading-signals/indicators.ts`. Pure math functions, zero external dependencies. Input: OHLCV arrays (newest-first, matching Twelve Data order).

### 1. RSI — Relative Strength Index

- **Parameters**: 14-period, Wilder smoothing
- **Purpose**: Momentum & overbought/oversold detection
- **Interpretation fed to AI**:
  - `> 70` = overbought (caution for longs)
  - `< 30` = oversold (potential bounce)
  - `> 50` = bullish momentum
  - `< 50` = bearish momentum

### 2. MACD — Moving Average Convergence Divergence

- **Parameters**: Fast 12, Slow 26, Signal 9
- **Returns**: MACD line, signal line, histogram
- **Purpose**: Momentum crossovers
- **Interpretation fed to AI**:
  - Histogram `> 0` = bullish
  - Histogram `< 0` = bearish
  - `|histogram| < 0.5` = near crossover

### 3. EMA — Exponential Moving Average

- **Parameters**: 20-period
- **Purpose**: Short-term trend direction
- **Interpretation**: Price above EMA(20) = bullish short-term

### 4. SMA — Simple Moving Average

- **Parameters**: 50-period and 200-period
- **Purpose**: Medium and long-term trend
- **Interpretation**:
  - Price above SMA(50) = bullish medium-term
  - Price above SMA(200) = bullish long-term
  - SMA(50) above SMA(200) = golden cross alignment

### 5. ATR — Average True Range

- **Parameters**: 14-period, Wilder smoothing
- **Purpose**: Volatility measurement + stop-loss sizing
- **Interpretation fed to AI**:
  - ATR as % of price: `> 3%` = high, `1.5-3%` = moderate, `< 1.5%` = low
- **Also used for**: Auto mode detection, AI stop-loss recommendations

### 6. ADX — Average Directional Index

- **Parameters**: 14-period
- **Purpose**: Trend strength (not direction)
- **Interpretation fed to AI**:
  - `> 25` = trending (tradeable)
  - `< 20` = weak/no trend (ranging)
  - `20-25` = trend developing
- **Also used for**: Auto mode detection

### 7. Volume Ratio

- **Parameters**: Current volume vs 20-day average
- **Purpose**: Participation confirmation
- **Interpretation fed to AI**:
  - `> 1.2x` = above average (institutional interest)
  - `< 0.8x` = below average (low conviction)
  - `0.8-1.2x` = normal

### 8. Support & Resistance

- **Method**: Swing high/low detection with 5-bar lookback
- **Returns**: 2 nearest support levels (below price), 2 nearest resistance levels (above price)
- **Purpose**: Key entry/exit zones for the AI

### 9. EMA/SMA Crossover Detection

- **Method**: Compares EMA(20) vs SMA(50) on current and previous bar
- **Returns**: `bullish_cross` | `bearish_cross` | `above` | `below`
- **Purpose**: Classic crossover signal
  - `bullish_cross` = EMA(20) just crossed above SMA(50)
  - `bearish_cross` = EMA(20) just crossed below SMA(50)

### 10. Trend Classification

- **Method**: Price position relative to SMA(50) and SMA(200)
- **Returns**: `strong_uptrend` | `uptrend` | `sideways` | `downtrend` | `strong_downtrend`
- **Logic**:
  - Price > SMA(50) > SMA(200) = **Strong Uptrend**
  - Price > both MAs = **Uptrend**
  - Mixed signals = **Sideways**
  - Price < both MAs = **Downtrend**
  - Price < SMA(50) < SMA(200) = **Strong Downtrend**

---

## Market Context (SPY + VIX)

Fetched in parallel with the stock's candle data:

- **SPY**: 60 daily candles → compute SMA(50) → determine if SPY is in an uptrend or downtrend
- **VIX**: Current close → classify fear level:
  - `< 15` = Low
  - `15-20` = Moderate
  - `20-30` = High
  - `> 30` = Extreme

Included in the AI prompt as: `SPY: Bullish (above SMA50) | VIX: 14.2 (Low fear)`

---

## How Indicators Map to the Analysis Framework

These indicators cover the standard technical analysis workflow:

| Analysis Step | Indicator(s) Used |
|---|---|
| Filter for Liquidity | Volume Ratio (current vs 20-day avg) |
| Filter for Volatility | ATR(14) as % of price |
| Filter for a Trend | SMA(50), SMA(200), Trend Classification |
| Identify Support & Resistance | Swing high/low detection |
| Check RSI | RSI(14) with momentum labeling |
| Moving Average Crossover | EMA(20) vs SMA(50) crossover detection |
| Confirm with Volume | Volume Ratio (above/below average) |
| Set Stop-Loss | ATR-based sizing + S/R levels |
| Set Take-Profit | Dual targets at S/R levels |

**Important**: We do NOT use these as hard filters that block analysis. The user picks the ticker; we analyze it comprehensively. If a stock fails multiple checks (low volume, no trend, weak RSI), the AI reflects that in a lower confidence score and HOLD recommendation rather than refusing to analyze.

---

## AI Prompt Structure

The enriched prompt sent to Gemini includes:

```
TECHNICAL INDICATORS (pre-computed from candle data):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Momentum:
  RSI(14): 62.3 — bullish, not overbought
  MACD(12,26,9): line 1.24, signal 0.87, histogram +0.37 — bullish

Trend:
  EMA(20): $184.50 — price ABOVE (bullish short-term)
  SMA(50): $178.20 — price ABOVE (bullish medium-term)
  SMA(200): $165.40 — price ABOVE (bullish long-term)
  ADX(14): 31.5 — TRENDING (above 25 threshold)
  MA Crossover: EMA(20) above SMA(50) — bullish alignment
  Overall Trend: STRONG UPTREND (price > SMA50 > SMA200)

Volatility:
  ATR(14): $3.82 (2.1% of price) — moderate

Volume:
  Current: 12.4M vs 20-day avg 8.2M — 1.51x ABOVE average

Key Levels:
  Support: $178.20, $172.50
  Resistance: $192.80, $198.00

Market Context:
  SPY: Bullish (above SMA50) | VIX: 14.2 (Low fear)
```

Plus trimmed candles (last 40 per timeframe) for the AI to validate against, and news headlines.

---

## AI Output Format

The trade agent returns:

- **recommendation**: BUY / SELL / HOLD
- **bias**: Short description (e.g., "Bullish continuation")
- **confidence**: 0-10 numeric score
- **entryPrice** + **stopLoss** + **targetPrice** (conservative) + **targetPrice2** (stretch)
- **riskReward**: e.g., "1:2.3"
- **rationale**: { technical, sentiment, risk } — 2-3 sentences each
- **scenarios**: { bullish, neutral, bearish } with probability % and summary

---

## Caching Strategy

Frontend in-memory cache to avoid redundant API calls:

| Mode | Cache TTL | Rationale |
|------|----------|-----------|
| Swing Trade | 15 minutes | Daily/weekly candles barely change |
| Day Trade | 3 minutes | Intraday data moves faster |

- Auto mode results are cached under their **resolved** mode (Swing or Day)
- Switching from Auto → Swing manually serves the cached result instantly
- Refresh button always bypasses cache

---

## Files

| File | Purpose |
|------|---------|
| `supabase/functions/trading-signals/indicators.ts` | Pure math indicator engine |
| `supabase/functions/trading-signals/index.ts` | Edge function: fetch data, compute indicators, call Gemini, build response |
| `app/src/lib/tradingSignalsApi.ts` | Frontend types + API caller |
| `app/src/components/TradingSignals.tsx` | UI: mode toggle, signal card, scenarios, indicators panel, chart |

---

## What We Don't Do (by design)

- **No stock screening** — User picks the ticker; we analyze it. We're not a screener.
- **No Beta** — Would require a separate API call. ATR covers volatility needs.
- **No macro/sector rotation** — We provide SPY/VIX context but don't analyze sector themes.
- **No multi-stock batch analysis** — One ticker at a time for focused analysis.
- **No Finviz/TradingView integration** — All indicators computed from Twelve Data candles.
