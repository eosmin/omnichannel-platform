-- Rolls back 20261121100000_inventory_schema. DESTRUCTIVE: the warehouses, their store links, every stock level, every
-- allocation of an order line and every movement of the ledger are DROPPED with their rows (stock quantities and the
-- cost of the units are lost), the three store settings lose their values, and the permission products:view_cost is
-- taken from the roles. Take a copy of those tables first if their rows matter. Run it before the code that reads
-- them is brought back. Safe to run twice.
BEGIN;

DELETE FROM "permissions" WHERE "name" = 'products:view_cost';

-- The ledger first: it refers to warehouses and to the composite key of products
GRANT UPDATE, DELETE ON TABLE inventory_movements TO platform_app, platform_worker;
DELETE FROM inventory_movements;
ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS chk_inventory_movements_quantity_positive;
ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS chk_inventory_movements_unit_cost;
ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS chk_inventory_movements_reserved_after;
ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS "inventory_movements_store_id_product_id_fkey";
ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS "inventory_movements_warehouse_id_fkey";
ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS "inventory_movements_variant_id_fkey";
DROP INDEX IF EXISTS "inventory_movements_idempotency_key_key";
DROP INDEX IF EXISTS "inventory_movements_store_id_warehouse_id_created_at_idx";
DROP INDEX IF EXISTS "inventory_movements_warehouse_id_idx";
DROP INDEX IF EXISTS "inventory_movements_variant_id_idx";
ALTER TABLE inventory_movements
  DROP COLUMN IF EXISTS "idempotency_key",
  DROP COLUMN IF EXISTS "note",
  DROP COLUMN IF EXISTS "on_hand_after",
  DROP COLUMN IF EXISTS "reason",
  DROP COLUMN IF EXISTS "reference_id",
  DROP COLUMN IF EXISTS "reference_type",
  DROP COLUMN IF EXISTS "reserved_after",
  DROP COLUMN IF EXISTS "unit_cost_cents",
  DROP COLUMN IF EXISTS "warehouse_id";
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS "reference" TEXT;
ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS "inventory_movements_product_id_fkey";
ALTER TABLE inventory_movements
  ADD CONSTRAINT "inventory_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "inventory_movements_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DROP TABLE IF EXISTS order_item_allocations;
DROP TABLE IF EXISTS inventory_levels;
DROP TABLE IF EXISTS store_warehouses;
DROP TABLE IF EXISTS warehouses;

DROP INDEX IF EXISTS "stores_organization_id_id_key";
DROP INDEX IF EXISTS "products_store_id_id_key";

ALTER TABLE store_settings DROP CONSTRAINT IF EXISTS chk_store_settings_default_low_stock;
ALTER TABLE store_settings
  DROP COLUMN IF EXISTS "allow_negative_stock",
  DROP COLUMN IF EXISTS "allow_split_fulfillment",
  DROP COLUMN IF EXISTS "default_low_stock_threshold";

COMMIT;
