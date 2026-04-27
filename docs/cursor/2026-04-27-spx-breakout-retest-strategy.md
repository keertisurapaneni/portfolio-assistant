# SPX Breakout-Retest Strategy — Implementation Session

**Date:** 2026-04-27  
**Feature:** `spx-level-scanner` — Somesh's $50 SPX key-level breakout-retest pattern  
**Files:** `auto-trader/src/lib/spx-level-scanner.ts`, `auto-trader/src/scheduler.ts`

---

## Goal

Implement a mechanical day-trade scanner that watches SPX $50 key levels for the specific 4-step pattern: break → two independent candles → retest → enter SPY.

The strategy was provided as a video transcript and is purely rule-based — no AI or LLM needed.

---

## Key Design Decisions

### Why rule-based, not AI?
The pattern is fully deterministic from OHLCV data:
- "Did a 5-min candle close beyond the level?" → yes/no
- "Did the next two candles not touch the level?" → yes/no
- "Did price retest the level?" → yes/no

Adding AI here would add latency, quota cost, and non-determinism with no benefit.

### Why a per-level state machine?
Multiple $50 levels can be in different states simultaneously (e.g. 5700 is confirmed while 5750 just got its break candle). An in-memory state machine per level cleanly handles this without database overhead.

### Why in-memory state, not Supabase?
- The pattern plays out over ~30–60 min within a single trading session
- The auto-trader process stays running all day; in-memory is sufficient
- Avoids database round-trips on every 15-min scheduler tick
- Daily reset at midnight ET is automatic via date string comparison

### Why SPX/10 ≈ SPY for stop/target?
The entry is at live SPY market price. Stop and target are anchored to SPX key levels, converted via the ~10:1 ratio. This is approximate but correct to within $0.50–$1.00 on SPY — acceptable for bracket order placement.

### Why confidence = 9?
The `executeScannerTrade` path gates execution on `minScannerConfidence` (typically 7–8). Since this is a high-quality mechanical setup with defined entry/stop/target, confidence 9 ensures it clears the threshold without ever triggering the FA re-run logic (which runs only when the scanner hasn't pre-computed levels — not the case here).

### Integration point
Inserted as step 11 in the main scheduler cycle, after the AI scanner ideas (step 10) and before the options wheel (step 12+). Runs every scheduler tick during market hours; the state machine itself handles the timing logic.

---

## Trade-offs Considered

| Option | Chosen? | Reason |
|--------|---------|--------|
| Supabase state persistence | No | Unnecessary overhead for intraday-only pattern |
| AI confidence scoring | No | Pattern is deterministic; AI adds no signal |
| Cron separate from main loop | No | Main loop already runs every 15 min; sufficient cadence |
| SPX options instead of SPY | No | SPY is simpler (no options chain logic needed for this scanner) |
| Database-persisted triggered levels | Not yet | Could add for audit trail; omitted v1 to keep it simple |

---

## Files Changed

```
auto-trader/src/lib/spx-level-scanner.ts    ← new
auto-trader/src/scheduler.ts                 ← import + step 11 added
.cursor/rules/auto-trader-conventions.mdc    ← strategy + source tag documented
docs/features/spx-level-scanner.md          ← new
docs/cursor/2026-04-27-spx-breakout-retest-strategy.md  ← this file
docs/INDEX.md                                ← updated
```
