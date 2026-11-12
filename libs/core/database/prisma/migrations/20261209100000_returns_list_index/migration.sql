-- CreateIndex
CREATE INDEX "order_returns_store_created_idx" ON "order_returns"("store_id", "created_at" DESC, "id" DESC);
