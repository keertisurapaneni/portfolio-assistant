-- Remove Casper Clipping as a signal source.
-- The candlestick strategy it described (wick rejection, engulfing, momentum candles)
-- is now implemented natively in the scanner/FA confirmation logic.
-- Expire all pending signals from these videos and mark them inactive.

UPDATE external_strategy_signals
   SET status = 'EXPIRED'
 WHERE source_name IN ('Casper Clipping', 'casperclipping')
   AND status = 'PENDING';

UPDATE strategy_videos
   SET status = 'deactivated'
 WHERE source_handle IN ('casperclipping', 'caspersmcwisdom')
    OR source_name ILIKE '%casper%';
