-- Rolls back 20270127600000_drop_messages_search_vector: recreates the generated column, as 20261024182905_raw_sql made it. Safe to run twice.
-- Data: nothing is lost, the column is GENERATED ALWAYS from `content`, so Postgres recomputes every value. The ADD rewrites the table,
-- so run it in a window; nothing in the code reads the column, so the rollback is only needed to return to the old schema.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('spanish', coalesce(content, ''))) STORED;
COMMIT;
