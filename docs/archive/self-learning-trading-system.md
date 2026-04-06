# Self-Learning Trading System

**Date:** 2026-03-06  
**Branch:** feat/force-execute-skip-gates (extended)  
**Goal:** Make the auto-trader self-optimizing — it should analyze its own performance and adjust strategy without manual intervention.

---

## Context

- Portfolio was -$6k (unrealized -$6,937 + realized -$3,142), 44% win rate on 34 closed trades.
- Influencer day trades were making money but getting too few entries.
- Generic strategy matching was blind — all strategies treated equally regardless of performance history.
- Many config parameters were manually tuned; no feedback loop from trade outcomes back to config.

---

## What Was Built

### 1. Auto-Tune Edge Function (`supabase/functions/auto-tune-strategy-config/`)

Runs after market close (daily). Analyzes the last 30 days of closed trades and applies bounded adjustments to `auto_trader_config`.

**Tuning rules:**

| Rule | Trigger | Action |
|------|---------|--------|
| A — Influencer sizing | Win rate + profit factor | Scale `external_signal_position_size` ±20% |
| B — Scanner confidence | Scanner/swing win rate + PF | Adjust `min_scanner_confidence` ±0.5 |
| C — Base allocation | Swing trade profit factor | Adjust `base_allocation_pct` ±0.5% |
| D — LT bucket | Long-term profit factor | Adjust `long_term_bucket_pct` ±5% |
| E — Kelly | 25+ closed trades exist | Enable `kelly_adaptive_enabled` |
| F — Max positions | Overall + influencer PF | Adjust `max_positions` ±1 |

**Bounds (hard limits):**

| Param | Min | Max |
|-------|-----|-----|
| `external_signal_position_size` | $1,000 | $15,000 |
| `min_scanner_confidence` | 6.0 | 9.0 |
| `base_allocation_pct` | 0.5% | 5.0% |
| `long_term_bucket_pct` | 15% | 60% |
| `max_positions` | 2 | 8 |

Max ±20% change per run for dollar values. Changes are applied to `auto_trader_config` and logged to `strategy_tune_log`.

### 2. EV-Weighted Generic Strategy Matching (`scheduler.ts`)

`autoQueueGenericSignalsFromTrackedVideos` now scores each generic strategy video by **expected value (EV = win_rate × avg_return_pct)** from its last 30 closed trades.

**Selection logic:**
- Sort strategies by EV (proven positives first)
- Apply top `MAX_GENERIC_STRATEGIES_PER_TICKER` (=3) per scanner idea
- Always include at least 1 unproven strategy (< 5 trades) to keep accumulating data
- Hard-cut strategies with proven EV < -0.3 (they've shown they're money losers)

**EV score caching:** 30-minute cache to avoid DB hammering on every scheduler cycle.

### 3. `strategy_tune_log` Table (migration: 20260306000001)

```sql
id, run_at, trigger, analysis (jsonb), decisions (jsonb), applied, notes
```

Each row = one daily auto-tune pass. `decisions` array shows exactly what changed and why. Fully auditable.

### 4. `runAutoTuneStrategyConfig()` in scheduler

Called from `runDailyRehydration()` after market close. Calls the edge function once per trading day. Logs all decisions to console. Invalidates EV score cache after changes so the next trading cycle picks up the new config.

---

## Architecture Flow

```
Market close (4:15 PM ET)
  → runDailyRehydration()
      → syncPositions()
      → recalculatePerformance()
      → analyzeUnreviewedTrades()
      → runAutoTuneStrategyConfig()  ← NEW
          → POST /auto-tune-strategy-config
              → analyze last 30d by category
              → apply bounded rule set
              → upsert auto_trader_config
              → insert strategy_tune_log row
              → return decisions
          → log decisions to console
          → clear EV score cache

Next trading cycle
  → autoQueueGenericSignalsFromTrackedVideos()  ← IMPROVED
      → getGenericStrategyEVScores()  ← NEW (30min cache)
          → query paper_trades by strategy_video_id
          → compute EV per video
      → rank strategies by EV
      → selectTopStrategies()  ← NEW
          → top-2 proven + 1 unproven
      → queue only top strategies for each scanner idea
```

---

## Key Design Decisions

**Why bounded adjustments?** Unbounded auto-tuning can compound errors — if a strategy has a bad week due to market conditions (not strategy failure), an unbounded system could over-correct. ±20% per run means recovery is possible within 5 sessions.

**Why keep unproven strategies?** The system needs exploration to learn. If we only fire proven strategies, new strategies never get enough data to prove themselves. One unproven slot per cycle balances exploration vs exploitation.

**Why 8-trade minimum before tuning fires?** With < 8 trades, win rate swings wildly. A 3-trade sample at 33% WR could be noise. 8 trades gives a more stable estimate.

**Why separate influencer vs scanner day trades?** Influencer signals (with `strategy_video_id`) behave differently than scanner signals — they come with specific entry levels and have a different edge profile. Conflating them would obscure which source is winning/losing.

---

## Next Steps (Phase 3 — Pattern Learning)

1. **Store winning trade DNA** — Add a post-close job that extracts `{setup_type, entry_time_bucket, spy_alignment, volume_ratio, market_condition}` from every winning trade into a `learned_strategy_patterns` table.

2. **Score scanner ideas against patterns** — Before executing a scanner trade, score it against the learned pattern library. High match → larger size. No match → standard size.

3. **Auto-discover new sources** — Track which `source_name` values on winning trades don't have corresponding `strategy_videos`, and surface them for review.

4. **Regime-aware tuning** — Add regime (SPY vs 200d + VIX) as a dimension in the auto-tune analysis. Different parameter sets for different regimes.
