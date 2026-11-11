-- Step 4.5: transfers of stock between the warehouses of an organization (TDD_16 §4.5).

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "from_warehouse_id" TEXT NOT NULL,
    "to_warehouse_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "dispatched_by" TEXT,
    "dispatched_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_lines" (
    "id" TEXT NOT NULL,
    "transfer_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "variant_id" TEXT,
    "quantity" INTEGER NOT NULL,
    "received_quantity" INTEGER NOT NULL DEFAULT 0,
    "shortage_action" TEXT,

    CONSTRAINT "stock_transfer_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_transfers_organization_id_status_idx" ON "stock_transfers"("organization_id", "status");

-- CreateIndex
CREATE INDEX "stock_transfers_organization_id_created_at_id_idx" ON "stock_transfers"("organization_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "stock_transfers_from_warehouse_id_idx" ON "stock_transfers"("from_warehouse_id");

-- CreateIndex
CREATE INDEX "stock_transfers_to_warehouse_id_idx" ON "stock_transfers"("to_warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_organization_id_number_key" ON "stock_transfers"("organization_id", "number");

-- CreateIndex
CREATE INDEX "stock_transfer_lines_transfer_id_idx" ON "stock_transfer_lines"("transfer_id");

-- CreateIndex
CREATE INDEX "stock_transfer_lines_store_id_idx" ON "stock_transfer_lines"("store_id");

-- CreateIndex
CREATE INDEX "stock_transfer_lines_product_id_variant_id_idx" ON "stock_transfer_lines"("product_id", "variant_id");

-- CreateIndex
CREATE INDEX "stock_transfer_lines_variant_id_idx" ON "stock_transfer_lines"("variant_id");

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_organization_id_from_warehouse_id_fkey" FOREIGN KEY ("organization_id", "from_warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_organization_id_to_warehouse_id_fkey" FOREIGN KEY ("organization_id", "to_warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "stock_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_store_id_product_id_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------
-- Raw SQL (what Prisma cannot declare)
-- ---------------------------------------------------------------------------------------------------------------

-- A transfer goes between two different warehouses, in a status that exists; the numbers read "TR-0001" and grow
ALTER TABLE stock_transfers
  ADD CONSTRAINT chk_stock_transfers_warehouses_differ CHECK (from_warehouse_id <> to_warehouse_id),
  ADD CONSTRAINT chk_stock_transfers_status CHECK (status IN ('draft', 'in_transit', 'received', 'cancelled')),
  ADD CONSTRAINT chk_stock_transfers_number CHECK (number ~ '^TR-[0-9]{4,}$'),
  -- What was sent has a sender and a moment (a draft has none; one cancelled before it left has none either), and
  -- a transfer that ended has the moment it ended
  ADD CONSTRAINT chk_stock_transfers_dispatch CHECK (
    CASE status
      WHEN 'draft' THEN dispatched_at IS NULL AND dispatched_by IS NULL
      WHEN 'in_transit' THEN dispatched_at IS NOT NULL AND dispatched_by IS NOT NULL
      WHEN 'received' THEN dispatched_at IS NOT NULL AND dispatched_by IS NOT NULL
      ELSE TRUE
    END
  ),
  ADD CONSTRAINT chk_stock_transfers_closed CHECK (
    (status IN ('received', 'cancelled')) = (closed_at IS NOT NULL)
  );

-- One line is a whole number of units, never more received than sent, and the shortage action is one that exists
ALTER TABLE stock_transfer_lines
  ADD CONSTRAINT chk_stock_transfer_lines_quantity CHECK (quantity > 0),
  ADD CONSTRAINT chk_stock_transfer_lines_received CHECK (received_quantity >= 0 AND received_quantity <= quantity),
  ADD CONSTRAINT chk_stock_transfer_lines_shortage_action CHECK (
    shortage_action IS NULL OR shortage_action IN ('write_off', 'return_to_source')
  );

-- One line per item in a transfer (a NULL variant_id is not a value to a unique index)
CREATE UNIQUE INDEX uq_stock_transfer_lines_product
  ON stock_transfer_lines (transfer_id, product_id) WHERE variant_id IS NULL;
CREATE UNIQUE INDEX uq_stock_transfer_lines_variant
  ON stock_transfer_lines (transfer_id, variant_id) WHERE variant_id IS NOT NULL;

-- A line names the store of its product, and the foreign keys cannot say that this store is one of the organization
-- of the transfer, nor that the variant is a variant of the product. These checks do, whoever writes.
CREATE FUNCTION check_transfer_line_belongs_together() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM stock_transfers t JOIN stores s ON s.organization_id = t.organization_id
    WHERE t.id = NEW.transfer_id AND s.id = NEW.store_id
  ) THEN
    RAISE EXCEPTION 'the store of a transfer line is not a store of the organization of the transfer'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'transfer_line_same_organization';
  END IF;
  IF NEW.variant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM product_variants v WHERE v.id = NEW.variant_id AND v.product_id = NEW.product_id
  ) THEN
    RAISE EXCEPTION 'the variant of a transfer line is not a variant of its product'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'transfer_line_variant_of_product';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_stock_transfer_lines_belong_together
  BEFORE INSERT OR UPDATE OF transfer_id, store_id, product_id, variant_id ON stock_transfer_lines
  FOR EACH ROW EXECUTE FUNCTION check_transfer_line_belongs_together();

-- inventory:manage_transfers and inventory:receive_transfers: the Admin and the Supervisor roles of the stores that
-- exist get them as the ones made from now on do (RolePresets).
INSERT INTO "permissions" ("id", "name", "role_id")
SELECT gen_random_uuid()::text, p.name, r."id"
FROM "roles" r
CROSS JOIN (VALUES ('inventory:manage_transfers'), ('inventory:receive_transfers')) AS p(name)
WHERE r."is_system" AND r."name" IN ('Admin', 'Supervisor')
ON CONFLICT ("role_id", "name") DO NOTHING;
