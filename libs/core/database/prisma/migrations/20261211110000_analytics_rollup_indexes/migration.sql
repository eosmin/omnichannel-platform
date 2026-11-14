-- The rollups of analytics read what happened in a period of one store: its conversations by creation, by resolution and by first answer, and its orders by creation.
CREATE INDEX "conversations_store_id_created_at_idx" ON "conversations"("store_id", "created_at");
CREATE INDEX "conversations_store_id_resolved_at_idx" ON "conversations"("store_id", "resolved_at");
CREATE INDEX "conversations_store_id_first_response_at_idx" ON "conversations"("store_id", "first_response_at");
CREATE INDEX "orders_store_id_created_at_idx" ON "orders"("store_id", "created_at");
