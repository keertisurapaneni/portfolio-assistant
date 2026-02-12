# Trading Signal Improvements — V2 (Feb 2026)

All 7 improvements deployed to `trading-signals` Supabase Edge Function.

## Files involved

- `supabase/functions/trading-signals/index.ts` — prompts, Finnhub data fetching, prompt assembly
- `supabase/functions/trading-signals/indicators.ts` — new gap detection indicator

---

## Tier 1 — Prompt and light data changes

### 1. Volume ratio emphasis (both modes)

Currently `formatIndicatorsForPrompt` outputs volume as a flat number. The prompts barely reference it.

**Changes:**

- In `indicators.ts` `formatIndicatorsForPrompt`: add qualitative labels for volume (e.g., "SURGE 3x+" / "HIGH 1.5x+" / "DRY < 0.5x") to make it impossible for the AI to ignore.
- In both `DAY_TRADE_USER` and `SWING_TRADE_USER` in `index.ts`: add a rule like "Volume ratio > 2x confirms the move; < 0.8x means the move is suspect — lower confidence."

### 2. Scaling out instruction (both modes)

We already return `targetPrice` and `targetPrice2` in the JSON schema but never tell the AI how to use them.

**Changes:**

- In both `DAY_TRADE_USER` and `SWING_TRADE_USER` Risk sections: add "Target 1 = take 50% profit. Move stop to breakeven. Target 2 = exit remaining position."

### 3. Short setups for day trade (day trade)

The current `DAY_TRADE_SYSTEM` says "aggressive intraday trader" but the rules lean long-only.

**Changes:**

- In `DAY_TRADE_SYSTEM`: add "You trade longs and shorts equally."
- In `DAY_TRADE_USER` Rules section: add "SELL (short) setups are equally valid. RSI > 70 + rejection at resistance + fading volume = short setup. A break above a key high that immediately reverses = failed breakout / liquidity grab — favor short."

### 4. Float / shares outstanding (day trade mainly)

Finnhub `/stock/metric` already returns `sharesOutstanding` in the same payload we fetch for fundamentals.

**Changes:**

- In `index.ts` `fetchFundamentals`: extract `sharesOutstanding` from the metrics response, add to `FundamentalData` interface.
- Compute approximate float: `sharesOutstanding` (Finnhub doesn't have exact float, but shares outstanding is a good proxy).
- Pass float context into the day trade prompt: "Shares outstanding: Xm. Under 20M = low float, expect explosive moves and wider spreads. Over 500M = mega cap, slower moves."
- In `DAY_TRADE_USER`: add rule "Low float (< 20M shares) + volume ratio > 3x = explosive setup, use wider stops. High float (> 500M) = grinder, tighter stops."

---

## Tier 2 — New indicator + data integration

### 5. Liquidity zone framing in day trade prompt (day trade)

No code change in indicators — just reframe how S/R levels are described to the AI.

**Changes:**

- In `DAY_TRADE_USER` Rules section: add "Support/resistance levels are liquidity zones where stop losses cluster. A break below support that quickly reverses = stop hunt / liquidity grab — this is bullish, not bearish. A break above resistance that immediately fails = bull trap. Look for these reversals as high-probability entries."

### 6. Gap detection indicator (swing trade mainly)

New indicator function to find unfilled price gaps in candle data.

**Changes in `indicators.ts`:**

- Add `GapInfo` interface: `{ type: 'up' | 'down', gapStart: number, gapEnd: number, filled: boolean }`
- Add `detectGaps(data: OHLCV[]): GapInfo[]` — scan consecutive daily candles for gaps where `bar[i].low > bar[i+1].high` (gap up) or `bar[i].high < bar[i+1].low` (gap down). Check if any subsequent bar has filled the gap.
- Add `gaps` to `IndicatorSummary` interface.
- Format unfilled gaps in `formatIndicatorsForPrompt` as "Unfilled gap up: $X - $Y" / "Unfilled gap down: $X - $Y".

**Changes in `index.ts`:**

- In `SWING_TRADE_USER`: add rule "Unfilled gaps are magnets — price tends to return to fill them. An unfilled gap below current price is a potential pullback target and buy zone. Use gap levels as entry/exit targets."

### 7. Earnings calendar awareness (both, critical for swing)

Finnhub `/calendar/earnings?symbol=X` returns upcoming earnings dates.

**Changes in `index.ts`:**

- Add `fetchEarningsCalendar(ticker, finnhubKey)` function that calls Finnhub earnings calendar endpoint and returns the next upcoming earnings date (if within 30 days).
- Call it in parallel with existing fetches.
- If earnings are within 7 days: inject "EARNINGS IN X DAYS" warning into the prompt.
- In `SWING_TRADE_USER`: add rule "If earnings are within 7 days, reduce position size guidance and widen stops. Never recommend a new swing entry within 3 days of earnings unless explicitly a pre-earnings play."
- In `DAY_TRADE_USER`: add rule "If earnings just reported (today/yesterday), expect elevated volume and volatility — this context matters for stop sizing."

---

## Ideas evaluated and rejected

- **"Narrative" confirmation** — Too speculative; news headlines already cover this.
- **Bull flag pattern detection** — Unreliable without ML; existing indicators (MACD histogram + volume + trend) capture the same signal.
- **Low-price stock context** — Already captured by ATR%; adding a price-level rule would be redundant.
