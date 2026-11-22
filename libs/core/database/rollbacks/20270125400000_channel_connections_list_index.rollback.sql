-- Rolls back 20270125400000_channel_connections_list_index: drops the index. The list and the directory keep working, sorting the rows of the store.
-- Safe to run twice.
DROP INDEX IF EXISTS "channel_connections_store_id_created_at_id_idx";
