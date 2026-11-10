-- Step 4.2 (PR A1): the data model of stock (TDD_16 §2, MVP_TRIM_CHECKLIST §8). Warehouses (of the ORGANIZATION),
-- the links of a store to them, the stock level of each item in each warehouse, the allocation of an order line to
-- warehouses, the new shape of the ledger (InventoryMovement) and three store settings. Additive except for the
-- ledger: its free-text `reference` becomes `reference_type` and `reference_id`, and it gains required columns.
--
-- Nothing writes to inventory_movements before this step (there is no endpoint and no service), so the table is
-- empty everywhere; the migration REFUSES to run if it is not, instead of inventing a warehouse for old rows. The table
-- is locked first, so that the check and the ALTERs that follow see the same table.
LOCK TABLE "inventory_movements" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "inventory_movements") THEN
    RAISE EXCEPTION 'inventory_movements is not empty: its rows have no warehouse to be given, decide what to do with them before this migration';
  END IF;
END $$;

-- DropForeignKey
ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_store_id_fkey";

-- DropForeignKey
ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_product_id_fkey";

-- DropForeignKey
ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_variant_id_fkey";

-- AlterTable
ALTER TABLE "store_settings" ADD COLUMN     "allow_negative_stock" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "allow_split_fulfillment" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "default_low_stock_threshold" INTEGER;

-- AlterTable
ALTER TABLE "inventory_movements" DROP COLUMN "reference",
ADD COLUMN     "idempotency_key" TEXT NOT NULL,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "on_hand_after" INTEGER NOT NULL,
ADD COLUMN     "reason" TEXT,
ADD COLUMN     "reference_id" TEXT,
ADD COLUMN     "reference_type" TEXT,
ADD COLUMN     "reserved_after" INTEGER NOT NULL,
ADD COLUMN     "unit_cost_cents" INTEGER,
ADD COLUMN     "warehouse_id" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "warehouses" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "address" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_warehouses" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,

    CONSTRAINT "store_warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_levels" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "variant_id" TEXT,
    "warehouse_id" TEXT NOT NULL,
    "on_hand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "value_cents" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_allocations" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_item_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_organization_id_code_key" ON "warehouses"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_organization_id_id_key" ON "warehouses"("organization_id", "id");

-- CreateIndex
CREATE INDEX "store_warehouses_warehouse_id_idx" ON "store_warehouses"("warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "store_warehouses_store_id_warehouse_id_key" ON "store_warehouses"("store_id", "warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "store_warehouses_store_id_priority_key" ON "store_warehouses"("store_id", "priority");

-- CreateIndex
CREATE INDEX "inventory_levels_store_id_warehouse_id_idx" ON "inventory_levels"("store_id", "warehouse_id");

-- CreateIndex
CREATE INDEX "inventory_levels_product_id_variant_id_idx" ON "inventory_levels"("product_id", "variant_id");

-- CreateIndex
CREATE INDEX "inventory_levels_warehouse_id_idx" ON "inventory_levels"("warehouse_id");

-- CreateIndex
CREATE INDEX "inventory_levels_variant_id_idx" ON "inventory_levels"("variant_id");

-- CreateIndex
CREATE INDEX "order_item_allocations_store_id_idx" ON "order_item_allocations"("store_id");

-- CreateIndex
CREATE INDEX "order_item_allocations_warehouse_id_idx" ON "order_item_allocations"("warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_item_allocations_order_item_id_warehouse_id_key" ON "order_item_allocations"("order_item_id", "warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "stores_organization_id_id_key" ON "stores"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "products_store_id_id_key" ON "products"("store_id", "id");

-- CreateIndex
CREATE INDEX "inventory_movements_store_id_warehouse_id_created_at_idx" ON "inventory_movements"("store_id", "warehouse_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "inventory_movements_warehouse_id_idx" ON "inventory_movements"("warehouse_id");

-- CreateIndex
CREATE INDEX "inventory_movements_variant_id_idx" ON "inventory_movements"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_store_id_idempotency_key_key" ON "inventory_movements"("store_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_store_id_product_id_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_warehouses" ADD CONSTRAINT "store_warehouses_organization_id_store_id_fkey" FOREIGN KEY ("organization_id", "store_id") REFERENCES "stores"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_warehouses" ADD CONSTRAINT "store_warehouses_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_store_id_product_id_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_allocations" ADD CONSTRAINT "order_item_allocations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_allocations" ADD CONSTRAINT "order_item_allocations_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_allocations" ADD CONSTRAINT "order_item_allocations_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------
-- Raw SQL (what Prisma cannot declare)
-- ---------------------------------------------------------------------------------------------------------------

-- A NULL variant_id must not allow duplicates (NULL <> NULL in a unique index): one level per item and warehouse
CREATE UNIQUE INDEX uq_inventory_levels_product
  ON inventory_levels (store_id, product_id, warehouse_id) WHERE variant_id IS NULL;
CREATE UNIQUE INDEX uq_inventory_levels_variant
  ON inventory_levels (store_id, variant_id, warehouse_id) WHERE variant_id IS NOT NULL;

-- Stock may be negative only when the store allows it (StoreSettings.allow_negative_stock): that cannot be a CHECK,
-- so InventoryService refuses it and the reconciliation job reports it. What no setting allows is checked here.
ALTER TABLE inventory_levels
  ADD CONSTRAINT chk_inventory_reserved_non_negative CHECK (reserved >= 0);
ALTER TABLE inventory_movements
  ADD CONSTRAINT chk_inventory_movements_quantity_positive CHECK (quantity > 0),
  ADD CONSTRAINT chk_inventory_movements_unit_cost CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  ADD CONSTRAINT chk_inventory_movements_reserved_after CHECK (reserved_after >= 0);
ALTER TABLE order_item_allocations
  ADD CONSTRAINT chk_order_item_allocations_quantity_positive CHECK (quantity > 0);
ALTER TABLE store_warehouses
  ADD CONSTRAINT chk_store_warehouses_priority CHECK (priority >= 1);
ALTER TABLE store_settings
  ADD CONSTRAINT chk_store_settings_default_low_stock CHECK (default_low_stock_threshold IS NULL OR default_low_stock_threshold >= 0);

-- The ledger is append-only (TDD_16 §2): the application roles can read and add, never change, remove or empty it
-- (the way audit_logs is kept). Nothing deletes it by cascade either: a store or a warehouse with stock cannot be
-- deleted (the foreign keys restrict it, TDD_16 §4.9). The security suite checks these privileges, so a later
-- GRANT ... ON ALL TABLES that gives them back fails the build.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE inventory_movements FROM platform_app, platform_worker;

-- Warehouse codes are printed on documents: one organization cannot hold two that read the same, whatever the case,
-- and a code or a name has no stray spaces and keeps the lengths of InventoryLimits.
CREATE UNIQUE INDEX uq_warehouses_code_lower ON warehouses (organization_id, lower(code));
ALTER TABLE warehouses
  ADD CONSTRAINT chk_warehouses_code CHECK (code = btrim(code) AND char_length(code) BETWEEN 1 AND 20),
  ADD CONSTRAINT chk_warehouses_name CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 100);

-- Stock names the store AND a warehouse, and the foreign keys cannot say that the two belong to the same
-- organization (a level is not a link: a store may keep stock in a warehouse it was unlinked from, TDD_16 §4.7), nor
-- that a variant is a variant of the product the row names, nor that an allocation is of an order line of the store
-- it names. These checks do, for every insert and every change of those columns, whoever writes.
CREATE FUNCTION check_stock_row_belongs_together() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  row jsonb := to_jsonb(NEW);
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM warehouses w JOIN stores s ON s.organization_id = w.organization_id
    WHERE w.id = NEW.warehouse_id AND s.id = NEW.store_id
  ) THEN
    RAISE EXCEPTION 'the warehouse and the store of a stock row belong to different organizations'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'stock_row_same_organization';
  END IF;
  IF row ->> 'variant_id' IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM product_variants v
    WHERE v.id = row ->> 'variant_id' AND v.product_id = row ->> 'product_id'
  ) THEN
    RAISE EXCEPTION 'the variant of a stock row is not a variant of its product'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'stock_row_variant_of_product';
  END IF;
  IF TG_TABLE_NAME = 'order_item_allocations' AND NOT EXISTS (
    SELECT 1 FROM order_items i JOIN orders o ON o.id = i.order_id
    WHERE i.id = row ->> 'order_item_id' AND o.store_id = NEW.store_id
  ) THEN
    RAISE EXCEPTION 'the allocation is of an order line of another store'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'stock_row_order_of_store';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_inventory_levels_belong_together
  BEFORE INSERT OR UPDATE OF store_id, warehouse_id, product_id, variant_id ON inventory_levels
  FOR EACH ROW EXECUTE FUNCTION check_stock_row_belongs_together();
CREATE TRIGGER trg_inventory_movements_belong_together
  BEFORE INSERT OR UPDATE OF store_id, warehouse_id, product_id, variant_id ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION check_stock_row_belongs_together();
CREATE TRIGGER trg_order_item_allocations_belong_together
  BEFORE INSERT OR UPDATE OF store_id, warehouse_id, order_item_id ON order_item_allocations
  FOR EACH ROW EXECUTE FUNCTION check_stock_row_belongs_together();

-- PRODUCTS_VIEW_COST: who may see and change the reference cost of a product. The Admin role holds every
-- permission, so the stores that exist get it as the ones made from now on do (RolePresets).
INSERT INTO "permissions" ("id", "name", "role_id")
SELECT gen_random_uuid()::text, 'products:view_cost', r."id"
FROM "roles" r
WHERE r."is_system" AND r."name" = 'Admin'
ON CONFLICT ("role_id", "name") DO NOTHING;
