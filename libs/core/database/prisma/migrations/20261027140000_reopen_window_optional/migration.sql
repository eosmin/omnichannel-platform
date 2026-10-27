-- A customer keeps one thread per channel (Step 2.6). reopen_window_days becomes optional: NULL, the
-- new default, means a new conversation is never started for a customer who already has one on the
-- channel; a number means one is started after that many quiet days.
--
-- Nothing read the old value (the inbound pipeline did not exist), so the stores that still hold the
-- 7 that the old default wrote go to NULL, the new default. A store that chose another number keeps it.
ALTER TABLE store_settings ALTER COLUMN reopen_window_days DROP NOT NULL;
ALTER TABLE store_settings ALTER COLUMN reopen_window_days DROP DEFAULT;
UPDATE store_settings SET reopen_window_days = NULL WHERE reopen_window_days = 7;
