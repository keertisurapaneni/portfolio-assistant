# Day Trade Validation — Analysis Queries

Run these after 10–20 trading days to answer:

- **Are large-cap trend days working?**
- **Are chop days killing it?**
- **Is confidence ≥7 actually predictive?**

## Logged Fields (per trade)

| Column | Description |
|--------|-------------|
| `in_play_score` | InPlayScore at scan time |
| `pass1_confidence` | Gemini Pass 1 (indicator-only) |
| `scanner_confidence` / `fa_confidence` | Pass 2 confidence |
| `entry_trigger_type` | bracket_limit \| market \| dip_buy \| profit_take |
| `r_multiple` | Realized R at close |
| `opened_at` | Time of entry |
| `market_condition` | trend \| chop (VIX < 20 = trend) |

---

## 1. Trend vs Chop Performance

```sql
SELECT
  market_condition,
  COUNT(*) AS trades,
  SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
  ROUND(100.0 * SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) AS win_rate_pct,
  ROUND(AVG(pnl), 2) AS avg_pnl,
  ROUND(AVG(r_multiple), 2) AS avg_r_multiple
FROM paper_trades
WHERE mode = 'DAY_TRADE'
  AND closed_at IS NOT NULL
  AND market_condition IS NOT NULL
  AND entry_trigger_type = 'bracket_limit'
GROUP BY market_condition;
```

---

## 2. Confidence ≥7 Predictive?

```sql
SELECT
  CASE WHEN fa_confidence >= 7 THEN 'conf_7plus' ELSE 'conf_below_7' END AS conf_bucket,
  COUNT(*) AS trades,
  SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
  ROUND(100.0 * SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) AS win_rate_pct,
  ROUND(AVG(r_multiple), 2) AS avg_r_multiple
FROM paper_trades
WHERE mode = 'DAY_TRADE'
  AND closed_at IS NOT NULL
  AND entry_trigger_type = 'bracket_limit'
GROUP BY 1;
```

---

## 3. Full Validation Log (export for analysis)

```sql
SELECT
  ticker,
  signal,
  opened_at,
  in_play_score,
  pass1_confidence,
  fa_confidence AS pass2_confidence,
  entry_trigger_type,
  r_multiple,
  pnl,
  pnl_percent,
  close_reason,
  market_condition
FROM paper_trades
WHERE mode = 'DAY_TRADE'
  AND closed_at IS NOT NULL
  AND entry_trigger_type = 'bracket_limit'
ORDER BY opened_at DESC
LIMIT 50;
```

---

## 4. InPlayScore vs Outcome

```sql
SELECT
  CASE
    WHEN in_play_score >= 2.5 THEN 'high'
    WHEN in_play_score >= 1.5 THEN 'mid'
    ELSE 'low'
  END AS inplay_bucket,
  COUNT(*) AS trades,
  ROUND(AVG(r_multiple), 2) AS avg_r_multiple,
  ROUND(100.0 * SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) AS win_rate_pct
FROM paper_trades
WHERE mode = 'DAY_TRADE'
  AND closed_at IS NOT NULL
  AND in_play_score IS NOT NULL
GROUP BY 1;
```
