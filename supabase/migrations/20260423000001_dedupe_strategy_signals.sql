-- Remove duplicate PENDING signals keeping the newest per (ticker, signal, entry_price, execute_on_date).
-- Duplicates arise when re-categorizing a video triggers a fresh import under a new strategy_video_id
-- while the old signals (different video_id) are not cleaned up.
DELETE FROM external_strategy_signals
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY ticker, signal, entry_price, execute_on_date
             ORDER BY created_at DESC
           ) AS rn
    FROM external_strategy_signals
    WHERE status = 'PENDING'
  ) ranked
  WHERE rn > 1
);

-- Partial unique index: among PENDING signals, the same
-- ticker+signal+entry_price+date can only exist once.
-- Using a partial index (not a table constraint) so it only applies to PENDING rows
-- and gracefully handles NULLs in strategy_video_id.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_signal_per_date
  ON external_strategy_signals (ticker, signal, entry_price, execute_on_date)
  WHERE status = 'PENDING';
