# Trade Scanner v4 — Track 1 Key Level Setups

**Date:** 2026-04-20  
**Problem:** Scanner almost never produced day trade signals — only found ideas on days with big movers. Core names like SPY, QQQ, TSLA, PLTR never showed up on flat days, even though those are the best day-trading vehicles.

---

## Root Cause Analysis

The v3 scanner was purely **reactive**: it waited for Yahoo gainers/losers to show movement, then ranked by InPlayScore, then filtered by AI confidence. On flat days:
1. Yahoo screener returned few/no movers
2. `TSLA`, `SPY`, `QQQ`, `PLTR` had low InPlayScore (not big % movers) → cut before AI
3. Even if they survived, AI gave them SKIP/low-confidence because "nothing special is happening"
4. Empty result got cached for 390 minutes → **dead day** for the whole session

Somesh (Kay Capitals) trades differently: he picks his core 5-6 names **every morning**, identifies key levels, and sets triggers. He doesn't wait for them to move — he sets up for when they do.

---

## Solution: Dual-Track Architecture (v4)

### Track 1 — Key Level Setups (proactive, always runs)

**What it does:**
- Takes the existing `KeyLevelSetup[]` output (which was already computed but unused for signals)
- Filters: `SOMESH_WATCHLIST` tickers always included; other tickers included if price is within 1.5×ATR of a trigger
- Calls AI (Gemini, Groq fallback) with a focused question: *"Which direction has edge today?"*
- Entry/stop/target are **pre-computed from price structure** — AI only picks direction + confidence
- Ideas tagged `key-level` + `watchlist`
- Produces signals even on flat days (just need to be near a level)

**SOMESH_WATCHLIST:**
```typescript
['SPY', 'QQQ', 'TSLA', 'NVDA', 'PLTR', 'AMD', 'AAPL', 'META', 'MSFT', 'IWM']
```

**Key level sources** (pure price structure, no AI):
- Previous day high/low (strength 4)
- 5-day range high/low (strength 3)
- SMA50/SMA200 when price is near them (strength 3-4)
- 52-week high/low when near (strength 5)
- Round numbers / psychological levels (strength 2)
- Levels clustered within 0.35×ATR to avoid noise

**AI prompt (TRACK1_SYSTEM):** Specialized for trigger-based setups. Asks "which direction has edge?" not "is this in play?" Considers: gap direction, above/below VWAP, RSI momentum, volume ratio, SMA trend.

### Track 2 — Mover Setups (reactive, existing system)

Unchanged except:
- `SOMESH_WATCHLIST` tickers re-injected after InPlayScore top-30 cut
- Empty results no longer overwrite previous good scan

---

## Key Changes Made

### `supabase/functions/trade-scanner/index.ts`

1. **Added `SOMESH_WATCHLIST`** constant (line ~133) — 10 core tickers always evaluated
2. **Added `TRACK1_SYSTEM` + `TRACK1_USER_PREFIX`** prompts — directional bias question for key-level setups
3. **Added `formatKeyLevelForAI()`** — formats KeyLevelSetup + live quote data into AI-readable text with pre-computed entry/stop/target
4. **Added `runTrack1KeyLevelIdeas()`** — fetches quotes for relevant setups, calls AI, maps response back to `TradeIdea[]` with pre-computed levels
5. **InPlayScore fix** — saves `preCutCandidates` before top-30 slice; re-injects SOMESH_WATCHLIST tickers that got cut
6. **Track 1 wiring** — after Track 2 Pass 2, runs `runTrack1KeyLevelIdeas(keyLevelSetups, GEMINI_KEYS)` and merges non-duplicate ideas into `dayIdeas`
7. **Empty result caching fix (day)** — `if (dayIdeas.length > 0) writeToDB(...)` else preserve previous scan
8. **Empty result caching fix (swing)** — same pattern for swing trades

---

## Trade-offs / Decisions

| Decision | Reasoning |
|---|---|
| Groq as fallback for Track 1 | Track 1 is a simpler question than full analysis. Groq (llama-3.3-70b) handles it well and is free. Saves Gemini quota for Pass 2. |
| Entry/stop/target from price structure, not AI | Prevents AI from hallucinating random levels. The key level scanner already identifies clean levels — AI's job is just direction. |
| 1.5×ATR proximity filter | Close enough to matter but not so tight that minor pullbacks get included. SOMESH_WATCHLIST bypasses this filter entirely. |
| Merge, don't replace | Track 1 adds ideas without removing Track 2 results. Tickers already covered by Track 2 (better analysis) are not overwritten by Track 1. |
| Final sort by confidence descending | Best ideas always shown first regardless of which track produced them. |

---

## Expected Outcome

- **Before:** Ideas on ~20-30% of trading days (only days with big movers)
- **After:** Ideas on ~90%+ of trading days (Track 1 runs every day as long as SOMESH_WATCHLIST is near a key level, which is almost always true)
- Key trades like SPY level breakout, QQQ support bounce, PLTR resistance break now surface daily
- Bear market days generate SELL/SHORT setups from Track 1 (price breaking below support)
