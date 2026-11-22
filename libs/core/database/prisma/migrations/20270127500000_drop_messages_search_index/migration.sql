-- Step 7.3-S14 (1/2): the full-text index of `messages` is unused since Step 5.1 (the search folds both sides and reads
-- `idx_messages_search_unaccent`), and it costs a write on every message insert. Drop it first, on its own, so the next
-- migration drops a column with no index left to unlink under its lock.
-- Rollback: rollbacks/20270127500000_drop_messages_search_index.rollback.sql (run it AFTER the rollback of 20270127600000: it needs the column).
-- Alone in its file and one statement only: DROP INDEX CONCURRENTLY cannot run in a transaction block, and Prisma sends a file of
-- one statement without wrapping it, so the writes to `messages` are never blocked.
DROP INDEX CONCURRENTLY IF EXISTS "idx_messages_search";
