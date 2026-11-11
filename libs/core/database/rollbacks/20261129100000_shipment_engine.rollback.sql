BEGIN;

-- Safe to run twice. Takes the two permissions out of the system roles the migration gave them to; a custom role that an admin
-- granted them keeps them (the permission is still a name of the catalog, only no route reads it after this rollback)
DELETE FROM "permissions" p
USING "roles" r
WHERE p."role_id" = r."id" AND r."is_system"
  AND p."name" IN ('shipping:manage', 'shipping:manage_pickups');

-- The old index refuses a second active guide of an order, and the new one allowed it after a package came back: if an
-- order holds both, the rollback stops and says so instead of choosing which guide to drop
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM shipments
    WHERE kind = 'outbound' AND status NOT IN ('cancelled', 'failed')
    GROUP BY order_id, origin_warehouse_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'an order holds a returned guide and a new one: cancel or settle one before rolling back';
  END IF;
END $$;

DROP INDEX IF EXISTS shipments_one_active_outbound;
CREATE UNIQUE INDEX shipments_one_active_outbound ON shipments (order_id, origin_warehouse_id) NULLS NOT DISTINCT
  WHERE kind = 'outbound' AND status NOT IN ('cancelled', 'failed');

ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_store_id_carrier_connection_id_fkey";
DROP INDEX IF EXISTS "orders_store_id_carrier_connection_id_idx";

COMMIT;
