-- Rollback of 20270125200000_plugin_idempotency_keys: the table goes with its policies, indexes and keys. A plugin that sent an
-- Idempotency-Key loses the replay of its earlier calls (the writes themselves stay). Safe to run twice.
BEGIN;
DROP TABLE IF EXISTS "plugin_idempotency_keys";
COMMIT;
