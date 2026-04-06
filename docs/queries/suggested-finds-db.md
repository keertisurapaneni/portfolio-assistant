# Suggested Finds — DB Query for Compounders vs Gold Mines

Run this in Supabase SQL Editor (Dashboard → SQL Editor) or via `supabase db execute`.

## Distribution of Suggested Finds (initial entries only, excludes dip buys)

```sql
-- Suggested Finds = LONG_TERM + BUY + not a dip buy
WITH suggested_finds AS (
  SELECT
    id,
    ticker,
    notes,
    scanner_reason,
    status,
    opened_at,
    CASE
      WHEN (notes ILIKE '%Gold Mine%' OR scanner_reason ILIKE '%Gold Mine%') THEN 'Gold Mine'
      WHEN (notes ILIKE '%Quiet Compounder%' OR notes ILIKE '%Steady Compounder%'
            OR scanner_reason ILIKE '%Quiet Compounder%' OR scanner_reason ILIKE '%Steady Compounder%') THEN 'Compounders'
      ELSE 'Unknown'
    END AS tag
  FROM paper_trades
  WHERE mode = 'LONG_TERM'
    AND signal = 'BUY'
    AND (notes IS NULL OR NOT notes LIKE 'Dip buy%')
)
SELECT
  tag,
  COUNT(*) AS count,
  ROUND(100.0 * COUNT(*) / NULLIF(SUM(COUNT(*)) OVER (), 0), 1) AS pct
FROM suggested_finds
GROUP BY tag
ORDER BY count DESC;
```

## Raw list (for inspection)

```sql
SELECT
  ticker,
  CASE
    WHEN (notes ILIKE '%Gold Mine%' OR scanner_reason ILIKE '%Gold Mine%') THEN 'Gold Mine'
    WHEN (notes ILIKE '%Quiet Compounder%' OR notes ILIKE '%Steady Compounder%'
          OR scanner_reason ILIKE '%Quiet Compounder%' OR scanner_reason ILIKE '%Steady Compounder%') THEN 'Compounders'
    ELSE 'Unknown'
  END AS tag,
  status,
  opened_at::date
FROM paper_trades
WHERE mode = 'LONG_TERM'
  AND signal = 'BUY'
  AND (notes IS NULL OR NOT notes LIKE 'Dip buy%')
ORDER BY opened_at DESC;
```

## Total Suggested Finds count (all time)

```sql
SELECT COUNT(*) AS total_suggested_finds
FROM paper_trades
WHERE mode = 'LONG_TERM'
  AND signal = 'BUY'
  AND (notes IS NULL OR NOT notes LIKE 'Dip buy%');
```
