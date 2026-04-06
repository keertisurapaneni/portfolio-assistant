# Swing Trade Validation — Underperformance Diagnostics

**Automated:** Paper Trading → Validation tab → Swing Trade. Funnel, verdict, chop vs trend, and recent trades load automatically. No manual scripts.

For raw SQL or custom analysis, use the queries below.

## Daily Funnel Metrics (`swing_trade_metrics`)

| Column | Description |
|--------|-------------|
| `date` | ET date (YYYY-MM-DD) |
| `swing_signals` | Total BUY/SELL from Pass 2 (with direction) |
| `swing_confident` | Those with confidence ≥ 7 |
| `swing_skipped_distance` | Skipped due to 4% price-distance rule |
| `swing_orders_placed` | Bracket limit orders placed |
| `swing_orders_expired` | Expired unfilled (2 trading days) |
| `swing_orders_filled` | Filled |

```sql
SELECT * FROM swing_trade_metrics ORDER BY date DESC LIMIT 14;
```

### Decision rules (after 2–3 weeks)

| If you see… | Likely cause | Action |
|-------------|--------------|--------|
| 80%+ skipped due to distance | Entry logic too strict | Loosen 4% rule or widen entry bands |
| 80%+ expire unfilled | Pullback levels too deep | Shallower pullbacks, tighter to price |
| Fill rate high, win rate low | Pullback quality problem | Better confirmation, avoid FOMO entries |
| No signals pass confidence | Scoring too strict | Lower threshold or refine regime bias |

**You need numbers before making decisions.**

---

## Logged Fields (per filled swing)

| Column | Description |
|--------|-------------|
| `pct_distance_sma20_at_entry` | % distance from SMA20 at entry: (price - sma20) / sma20 × 100 |
| `macd_histogram_slope_at_entry` | MACD histogram slope: increasing \| decreasing |
| `volume_vs_10d_avg_at_entry` | Volume on entry day / 10-day avg (e.g. 1.5 = 50% above avg) |
| `regime_alignment_at_entry` | SPY vs SMAs: above_both \| below_both \| mixed | The answer drives the next upgrade:

| Finding | Next upgrade |
|---------|--------------|
| **A) Chop** — losses concentrated in `market_condition = 'chop'` | Regime refinement |
| **B) Bear** — losses when SPY below SMAs (cross-ref dates) | Regime refinement |
| **C) Quick failures** — stop_loss within 1–2 days | Pullback quality refinement |
| **D) Reversals** — stop_loss after initial move our way | Pullback quality refinement |
| **E) Low fill rate** — many SUBMITTED/CLOSED never filled | Execution refinement |

---

## 1. A) Choppy vs Trend Performance (market_condition)

```sql
SELECT
  COALESCE(market_condition, 'unknown') AS market_condition,
  COUNT(*) AS trades,
  SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
  ROUND(100.0 * SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) AS win_rate_pct,
  ROUND(SUM(pnl)::numeric, 2) AS total_pnl,
  ROUND(AVG(pnl)::numeric, 2) AS avg_pnl
FROM paper_trades
WHERE mode = 'SWING_TRADE'
  AND fill_price IS NOT NULL
  AND status IN ('STOPPED', 'TARGET_HIT', 'CLOSED')
GROUP BY market_condition;
```

**Interpret:** If `chop` has much worse win rate / PnL than `trend` → **Regime refinement**.

---

## 2. C) & D) Close Reason + Time to Close

```sql
SELECT
  close_reason,
  COUNT(*) AS trades,
  ROUND(SUM(pnl)::numeric, 2) AS total_pnl,
  ROUND(AVG(EXTRACT(EPOCH FROM (closed_at - filled_at)) / 86400)::numeric, 1) AS avg_days_held
FROM paper_trades
WHERE mode = 'SWING_TRADE'
  AND fill_price IS NOT NULL
  AND filled_at IS NOT NULL
  AND closed_at IS NOT NULL
  AND status IN ('STOPPED', 'TARGET_HIT', 'CLOSED')
GROUP BY close_reason;
```

**Interpret:**
- Many `stop_loss` with **avg_days_held < 2** → **C) Good setups that fail quickly** → Pullback quality
- `stop_loss` with longer holds → **D) Reversals** → Pullback quality

---

## 3. C) Quick Failures (stop_loss within 2 days)

```sql
SELECT
  COUNT(*) AS quick_stop_losses,
  ROUND(SUM(pnl)::numeric, 2) AS total_pnl_quick_stops
FROM paper_trades
WHERE mode = 'SWING_TRADE'
  AND close_reason = 'stop_loss'
  AND fill_price IS NOT NULL
  AND filled_at IS NOT NULL
  AND closed_at IS NOT NULL
  AND EXTRACT(EPOCH FROM (closed_at - filled_at)) / 86400 < 2;
```

**Interpret:** If this is a large share of total losses → **C) Pullback quality refinement**.

---

## 4. E) Fill Rate (execution)

```sql
WITH swing AS (
  SELECT
    id,
    status,
    fill_price,
    entry_trigger_type,
    notes
  FROM paper_trades
  WHERE mode = 'SWING_TRADE'
    AND entry_trigger_type = 'bracket_limit'
)
SELECT
  COUNT(*) AS total_swing_bracket_orders,
  SUM(CASE WHEN fill_price IS NOT NULL THEN 1 ELSE 0 END) AS filled,
  SUM(CASE WHEN status IN ('SUBMITTED', 'CLOSED') AND fill_price IS NULL THEN 1 ELSE 0 END) AS never_filled,
  ROUND(100.0 * SUM(CASE WHEN fill_price IS NOT NULL THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) AS fill_rate_pct
FROM swing;
```

**Interpret:** If fill_rate_pct < 50% or many `never_filled` → **E) Execution refinement**.

---

## 5. B) Bear Market (requires SPY regime — manual cross-ref)

We don't store SPY regime per trade. To check **B)**:

1. Export closed swing trades with dates:
```sql
SELECT ticker, filled_at::date AS fill_date, pnl, close_reason, market_condition
FROM paper_trades
WHERE mode = 'SWING_TRADE'
  AND fill_price IS NOT NULL
  AND status IN ('STOPPED', 'TARGET_HIT', 'CLOSED')
ORDER BY filled_at;
```

2. Cross-reference `fill_date` with SPY (above/below SMA50, SMA200). If losses cluster when SPY was below both → **B) Regime refinement**.

---

## 6. Summary Dashboard (run all at once)

```sql
-- Swing: filled closed trades
WITH closed AS (
  SELECT *
  FROM paper_trades
  WHERE mode = 'SWING_TRADE'
    AND fill_price IS NOT NULL
    AND status IN ('STOPPED', 'TARGET_HIT', 'CLOSED')
),
-- Fill rate
fill_stats AS (
  SELECT
    COUNT(*) FILTER (WHERE entry_trigger_type = 'bracket_limit') AS bracket_orders,
    COUNT(*) FILTER (WHERE fill_price IS NOT NULL AND entry_trigger_type = 'bracket_limit') AS bracket_filled
  FROM paper_trades
  WHERE mode = 'SWING_TRADE'
)
SELECT
  'A_chop_vs_trend' AS metric,
  (SELECT json_agg(row_to_json(t)) FROM (
    SELECT market_condition, COUNT(*) AS n, ROUND(SUM(pnl)::numeric, 2) AS pnl
    FROM closed GROUP BY market_condition
  ) t) AS value
UNION ALL
SELECT
  'C_quick_stops' AS metric,
  (SELECT COUNT(*)::text FROM closed
   WHERE close_reason = 'stop_loss'
     AND EXTRACT(EPOCH FROM (closed_at - filled_at)) / 86400 < 2)::jsonb
UNION ALL
SELECT
  'E_fill_rate' AS metric,
  (SELECT ROUND(100.0 * bracket_filled / NULLIF(bracket_orders, 0), 1)::text FROM fill_stats)::jsonb;
```

---

## Decision Matrix

| Primary finding | Next polish |
|-----------------|------------|
| Chop losses >> trend losses | **Regime refinement** — tighten SPY bias, VIX filter |
| Bear-period losses | **Regime refinement** — add SPY SMA filter (already added) |
| Many quick stop_loss (<2 days) | **Pullback quality** — deeper pullbacks, tighter structure |
| Reversals (stop after move) | **Pullback quality** — better confirmation, avoid FOMO entries |
| Low fill rate | **Execution refinement** — entry timing, limit vs market, next-day open |
