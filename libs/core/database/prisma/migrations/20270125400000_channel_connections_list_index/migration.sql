-- Step 7.3-B11i: the list of the connections of a store and its directory read them in order of (created_at, id) and page by
-- that pair (keyset); the only index of the table by store is (store_id, status), which cannot give that order, so every page
-- sorted the rows of the store. This one serves both reads.
-- Rollback: rollbacks/20270125400000_channel_connections_list_index.rollback.sql
-- Alone in its file and one statement only: CREATE INDEX CONCURRENTLY cannot run in a transaction block, and Prisma sends a
-- file of one statement without wrapping it, so the build does not block the writes of a store that connects a channel.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "channel_connections_store_id_created_at_id_idx" ON "channel_connections" ("store_id", "created_at", "id");
