-- Step 4.8, PR C1: the shipment engine. Additive, except for the one index it widens.
--
-- 1. The planned carrier of an order (Order.carrierConnectionId, TDD_17 §4.13) becomes a real foreign key, composite with the
--    store like every other link to a connection, so the database refuses a carrier of another store. Nothing wrote the
--    column before this step; a value that points nowhere is cleared before the key is added, to keep the statement safe.
UPDATE "orders" o
SET "carrier_connection_id" = NULL
WHERE o."carrier_connection_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "carrier_connections" c
    WHERE c."id" = o."carrier_connection_id" AND c."store_id" = o."store_id"
  );

CREATE INDEX "orders_store_id_carrier_connection_id_idx" ON "orders"("store_id", "carrier_connection_id");

ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_carrier_connection_id_fkey" FOREIGN KEY ("store_id", "carrier_connection_id") REFERENCES "carrier_connections"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. The package that came back (`returned`) does not hold the order any more: it can be shipped again (debt (i) of PR B1,
--    TDD_17 §4.8). `delivered` still holds it, `cancel_pending` and `cancel_failed` too.
DROP INDEX shipments_one_active_outbound;
CREATE UNIQUE INDEX shipments_one_active_outbound ON shipments (order_id, origin_warehouse_id) NULLS NOT DISTINCT
  WHERE kind = 'outbound' AND status NOT IN ('cancelled', 'failed', 'returned');

-- 3. The first routes guarded by shipping:manage (create a guide, set a status, cancel, check) exist: the roles of the
--    stores that exist get it as the ones made from now on do (RolePresets). shipping:manage_pickups has no route yet
--    (pickups are Step 4.11) but is given with it, so the roles of a store are the same as the presets.
INSERT INTO "permissions" ("id", "name", "role_id")
SELECT gen_random_uuid()::text, 'shipping:manage', r."id"
FROM "roles" r
WHERE r."is_system" AND r."name" IN ('Admin', 'Supervisor', 'Agent')
ON CONFLICT ("role_id", "name") DO NOTHING;

INSERT INTO "permissions" ("id", "name", "role_id")
SELECT gen_random_uuid()::text, 'shipping:manage_pickups', r."id"
FROM "roles" r
WHERE r."is_system" AND r."name" IN ('Admin', 'Supervisor')
ON CONFLICT ("role_id", "name") DO NOTHING;
