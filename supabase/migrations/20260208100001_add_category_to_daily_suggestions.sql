-- Add category column to daily_suggestions for per-category caching
-- Default 'auto' preserves existing rows (the main "all categories" discovery)

ALTER TABLE daily_suggestions ADD COLUMN category TEXT NOT NULL DEFAULT 'auto';

-- Drop old unique constraint on date alone
ALTER TABLE daily_suggestions DROP CONSTRAINT daily_suggestions_suggestion_date_key;

-- Add composite unique constraint (one row per date+category)
ALTER TABLE daily_suggestions ADD CONSTRAINT daily_suggestions_date_category_key
  UNIQUE (suggestion_date, category);

-- Replace the old index with a composite one
DROP INDEX IF EXISTS idx_daily_suggestions_date;
CREATE INDEX idx_daily_suggestions_date_category
  ON daily_suggestions(suggestion_date, category);
