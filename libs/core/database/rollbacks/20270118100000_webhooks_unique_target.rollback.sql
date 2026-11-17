-- Rolls back 20270118100000_webhooks_unique_target: the store may hold two webhooks with the same address and
-- events again. Idempotent. The events stay in their canonical order and the copies the migration disabled stay
-- disabled: neither carries data that the old schema needs back.
BEGIN;

DROP INDEX IF EXISTS "uq_webhooks_store_url_events";

COMMIT;
