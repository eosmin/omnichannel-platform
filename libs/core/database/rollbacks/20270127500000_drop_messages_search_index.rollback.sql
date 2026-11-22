-- Rolls back 20270127500000_drop_messages_search_index: recreates the GIN index of messages.search_vector. Safe to run twice.
-- ORDER: run the rollback of 20270127600000 first (the column must exist). The build takes a write lock on `messages` while it runs.
CREATE INDEX IF NOT EXISTS "idx_messages_search" ON "messages" USING GIN ("search_vector");
