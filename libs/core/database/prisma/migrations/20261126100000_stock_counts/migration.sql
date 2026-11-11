-- Step 4.6: physical counts (TDD_16 §2, §4.6). A count belongs to the ORGANIZATION and to one of its warehouses; its
-- lines to the store of the product they count. Additive: two new tables, nothing existing is changed.

-- CreateTable
CREATE TABLE "stock_counts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "store_id" TEXT,
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "started_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "applied_by" TEXT,
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_count_lines" (
    "id" TEXT NOT NULL,
    "count_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "variant_id" TEXT,
    "expected_quantity" INTEGER NOT NULL,
    "counted_quantity" INTEGER,

    CONSTRAINT "stock_count_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_counts_organization_id_number_key" ON "stock_counts"("organization_id", "number");

-- CreateIndex
CREATE INDEX "stock_counts_organization_id_status_idx" ON "stock_counts"("organization_id", "status");

-- CreateIndex
CREATE INDEX "stock_counts_organization_id_warehouse_id_idx" ON "stock_counts"("organization_id", "warehouse_id");

-- CreateIndex
CREATE INDEX "stock_counts_organization_id_store_id_idx" ON "stock_counts"("organization_id", "store_id");

-- CreateIndex
CREATE INDEX "stock_count_lines_count_id_store_id_idx" ON "stock_count_lines"("count_id", "store_id");

-- CreateIndex
CREATE INDEX "stock_count_lines_store_id_idx" ON "stock_count_lines"("store_id");

-- CreateIndex
CREATE INDEX "stock_count_lines_store_id_product_id_variant_id_idx" ON "stock_count_lines"("store_id", "product_id", "variant_id");

-- CreateIndex
CREATE INDEX "stock_count_lines_variant_id_idx" ON "stock_count_lines"("variant_id");

-- AddForeignKey
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_count_id_fkey" FOREIGN KEY ("count_id") REFERENCES "stock_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_store_id_product_id_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------
-- Raw SQL (what Prisma cannot declare)
-- ---------------------------------------------------------------------------------------------------------------

-- The optional store filter of a count must be a store of the SAME organization. MATCH SIMPLE: a null store_id skips it.
ALTER TABLE stock_counts
  ADD CONSTRAINT stock_counts_organization_id_store_id_fkey
  FOREIGN KEY (organization_id, store_id) REFERENCES stores (organization_id, id) ON DELETE RESTRICT;

ALTER TABLE stock_counts
  ADD CONSTRAINT chk_stock_counts_status CHECK (status IN ('draft', 'counting', 'review', 'applied', 'cancelled')),
  -- Mirrors CountLimits (libs/core/domain/count-constants.ts): the prefix, at least four digits, and at most twelve so
  -- that the digits always fit the bigint the next number is read with
  ADD CONSTRAINT chk_stock_counts_number CHECK (number ~ '^CT-[0-9]{4,12}$'),
  -- The marker of an applied count is both columns or none, and only an applied count has it
  ADD CONSTRAINT chk_stock_counts_applied_pair CHECK ((applied_at IS NULL) = (applied_by IS NULL)),
  ADD CONSTRAINT chk_stock_counts_applied CHECK ((status = 'applied') = (applied_at IS NOT NULL)),
  -- The moments the status implies (a count goes back from review to counting, which clears submitted_at)
  ADD CONSTRAINT chk_stock_counts_started CHECK ((status IN ('draft', 'cancelled')) OR started_at IS NOT NULL),
  ADD CONSTRAINT chk_stock_counts_submitted CHECK (status NOT IN ('review', 'applied') OR submitted_at IS NOT NULL);

-- The snapshot may be negative (a store that allows negative stock); what staff count never is
ALTER TABLE stock_count_lines
  ADD CONSTRAINT chk_stock_count_lines_counted CHECK (counted_quantity IS NULL OR counted_quantity >= 0);

-- One line per item in a count (a NULL variant_id must not allow duplicates: NULL <> NULL in a unique index)
CREATE UNIQUE INDEX uq_stock_count_lines_product
  ON stock_count_lines (count_id, product_id) WHERE variant_id IS NULL;
CREATE UNIQUE INDEX uq_stock_count_lines_variant
  ON stock_count_lines (count_id, variant_id) WHERE variant_id IS NOT NULL;

-- A line names the store of its product, and that store must be of the organization of the count (the foreign keys
-- cannot say it), and its variant must be a variant of its product. Whoever writes, for every insert and every change
-- of those columns. A count limited to one store takes lines of that store only.
CREATE FUNCTION check_stock_count_line_belongs_together() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM stock_counts c JOIN stores s ON s.organization_id = c.organization_id
    WHERE c.id = NEW.count_id AND s.id = NEW.store_id AND (c.store_id IS NULL OR c.store_id = NEW.store_id)
  ) THEN
    RAISE EXCEPTION 'the store of a count line is not one this count may count'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'count_line_store_of_count';
  END IF;
  IF NEW.variant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM product_variants v WHERE v.id = NEW.variant_id AND v.product_id = NEW.product_id
  ) THEN
    RAISE EXCEPTION 'the variant of a count line is not a variant of its product'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'count_line_variant_of_product';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_stock_count_lines_belong_together
  BEFORE INSERT OR UPDATE OF count_id, store_id, product_id, variant_id ON stock_count_lines
  FOR EACH ROW EXECUTE FUNCTION check_stock_count_line_belongs_together();

-- The expected quantity is the snapshot of the moment the count started: it never changes afterwards
CREATE FUNCTION keep_stock_count_line_snapshot() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.expected_quantity IS DISTINCT FROM OLD.expected_quantity THEN
    RAISE EXCEPTION 'the expected quantity of a count line is the snapshot of the start and is never changed'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'count_line_snapshot_frozen';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_stock_count_lines_snapshot
  BEFORE UPDATE OF expected_quantity ON stock_count_lines
  FOR EACH ROW EXECUTE FUNCTION keep_stock_count_line_snapshot();

-- The lines explain the movements an applied count wrote: they are entered only while the count is open (inserted while
-- it is a draft being started or counting, counted while it is counting) and never touched once it is in review, applied
-- or cancelled. Deleting a count removes its lines with it (the cascade), which this trigger does not see.
CREATE FUNCTION check_stock_count_line_count_is_open() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  current_status text;
BEGIN
  SELECT status INTO current_status FROM stock_counts WHERE id = NEW.count_id;
  IF (TG_OP = 'INSERT' AND current_status NOT IN ('draft', 'counting'))
     OR (TG_OP = 'UPDATE' AND current_status IS DISTINCT FROM 'counting') THEN
    RAISE EXCEPTION 'the lines of a count are written only while the count is open'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'count_line_count_is_open';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_stock_count_lines_count_is_open
  BEFORE INSERT OR UPDATE OF counted_quantity ON stock_count_lines
  FOR EACH ROW EXECUTE FUNCTION check_stock_count_line_count_is_open();

-- A count never changes organization, warehouse or store filter: its lines were made for them
CREATE FUNCTION keep_stock_count_scope() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
     OR NEW.store_id IS DISTINCT FROM OLD.store_id THEN
    RAISE EXCEPTION 'the organization, warehouse and store of a count are never changed'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'count_scope_frozen';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_stock_counts_scope
  BEFORE UPDATE OF organization_id, warehouse_id, store_id ON stock_counts
  FOR EACH ROW EXECUTE FUNCTION keep_stock_count_scope();
