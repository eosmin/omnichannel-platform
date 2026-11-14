BEGIN;

-- Safe to run twice. Only indexes: dropping them changes no data, and the rollups go back to scanning the rows of the store.
DROP INDEX IF EXISTS "orders_store_id_created_at_idx";
DROP INDEX IF EXISTS "conversations_store_id_first_response_at_idx";
DROP INDEX IF EXISTS "conversations_store_id_resolved_at_idx";
DROP INDEX IF EXISTS "conversations_store_id_created_at_idx";

COMMIT;
