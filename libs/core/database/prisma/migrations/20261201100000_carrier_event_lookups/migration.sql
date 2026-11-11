-- Step 4.8 PR C2c: finding the shipment a carrier event is about, and the events kept under a code nobody had mapped.
-- A carrier names a package by its guide number (already indexed: `shipments_guide_per_connection`, unique per connection) or by
-- its own id, and the worker looks it up inside one connection, so the id gets an index. The partial index holds only the history
-- lines with no status (unmapped or ignored codes), which a replay reads and which are few next to the rest of the history.

-- CreateIndex
CREATE INDEX "shipments_connection_id_provider_shipment_id_idx" ON "shipments"("connection_id", "provider_shipment_id");

-- Raw SQL: the history lines with no status, by store (Prisma cannot express a partial index)
CREATE INDEX "shipment_events_unmapped_idx" ON "shipment_events"("store_id", "shipment_id") WHERE "status" IS NULL;
