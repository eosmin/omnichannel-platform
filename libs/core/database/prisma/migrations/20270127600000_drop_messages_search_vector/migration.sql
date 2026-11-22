-- Step 7.3-S14 (2/2): drop the generated column `messages.search_vector` (unused since Step 5.1; nothing reads or writes it, see the PR).
-- DROP COLUMN does not rewrite the table (the column is only marked dropped), so the lock is short. A lock_timeout makes the
-- statement fail fast instead of queueing behind a long transaction and blocking every message read and write behind it.
-- IRREVERSIBLE IN DATA: the rollback recreates the column, not its values (it is generated from `content`, so they come back by themselves).
-- Rollback: rollbacks/20270127600000_drop_messages_search_vector.rollback.sql
-- If the 5 s lock_timeout fires (a long transaction holds `messages`) Prisma marks the migration failed (P3009) and refuses later deploys: nothing was
-- changed (the statement is atomic), so run `prisma migrate resolve --rolled-back 20270127600000_drop_messages_search_vector` and deploy again in a quiet window.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "messages" DROP COLUMN IF EXISTS "search_vector";
