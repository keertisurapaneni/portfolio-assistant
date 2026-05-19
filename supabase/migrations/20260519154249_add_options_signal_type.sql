ALTER TABLE strategy_videos DROP CONSTRAINT IF EXISTS strategy_videos_strategy_type_check;
ALTER TABLE strategy_videos ADD CONSTRAINT strategy_videos_strategy_type_check 
  CHECK (strategy_type IN ('daily_signal', 'daily_penny', 'generic_strategy', 'options_signal'));
