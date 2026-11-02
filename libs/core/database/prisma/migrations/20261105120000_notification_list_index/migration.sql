-- The notification center lists the rows of one user in one store, newest first: this index serves
-- the filter and the order together.
-- CreateIndex
CREATE INDEX "notifications_user_id_store_id_created_at_idx" ON "notifications"("user_id", "store_id", "created_at" DESC);
