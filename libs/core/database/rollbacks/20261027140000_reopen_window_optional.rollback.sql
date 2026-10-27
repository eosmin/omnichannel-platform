-- Rolls back 20261027140000_reopen_window_optional: the column is required again, with the old
-- default of 7 days for the stores that had none.
UPDATE store_settings SET reopen_window_days = 7 WHERE reopen_window_days IS NULL;
ALTER TABLE store_settings ALTER COLUMN reopen_window_days SET DEFAULT 7;
ALTER TABLE store_settings ALTER COLUMN reopen_window_days SET NOT NULL;
