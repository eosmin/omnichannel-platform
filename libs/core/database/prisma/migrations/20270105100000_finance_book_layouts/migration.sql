-- Step 4B.8b-3 (TDD_18 §7, §13 row 6): the layout of a legal book of the organization, and the frozen book of a closed period. The format is
-- the accountant's call, so the layout is data, versioned and append-only: the book of a closed month is asked for again with the version it
-- was written with, and is served from its snapshot.

-- CreateTable
CREATE TABLE "finance_book_layouts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "book_kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "columns" JSONB NOT NULL,
    "sort" TEXT NOT NULL,
    "correlative_start" INTEGER NOT NULL,
    "correlative_restart" TEXT NOT NULL,
    "unissued_sales" TEXT NOT NULL,
    "accountant_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_book_layouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "finance_book_layouts_organization_id_book_kind_version_key" ON "finance_book_layouts"("organization_id", "book_kind", "version");

-- AddForeignKey
ALTER TABLE "finance_book_layouts" ADD CONSTRAINT "finance_book_layouts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The values of the enums of core (LegalBookKind, LegalBookSort, LegalBookCorrelativeRestart, LegalBookUnissuedSales) and the bounds of a layout
ALTER TABLE "finance_book_layouts" ADD CONSTRAINT chk_finance_book_layouts_kind CHECK (book_kind IN ('sales_taxpayers', 'sales_consumers', 'purchases'));
ALTER TABLE "finance_book_layouts" ADD CONSTRAINT chk_finance_book_layouts_sort CHECK (sort IN ('date', 'document'));
ALTER TABLE "finance_book_layouts" ADD CONSTRAINT chk_finance_book_layouts_restart CHECK (correlative_restart IN ('month', 'year'));
ALTER TABLE "finance_book_layouts" ADD CONSTRAINT chk_finance_book_layouts_unissued CHECK (unissued_sales IN ('consumers', 'excluded'));
ALTER TABLE "finance_book_layouts" ADD CONSTRAINT chk_finance_book_layouts_version CHECK (version >= 1);
ALTER TABLE "finance_book_layouts" ADD CONSTRAINT chk_finance_book_layouts_start CHECK (correlative_start BETWEEN 1 AND 1000000000);
ALTER TABLE "finance_book_layouts" ADD CONSTRAINT chk_finance_book_layouts_columns CHECK (jsonb_typeof("columns") = 'array' AND jsonb_array_length("columns") BETWEEN 1 AND 24);

-- A layout is never changed or deleted once written: a book of a closed month names the version it used, and that version must still say
-- the same thing. A correction is a new version. The service refuses first; this is the floor under it.
CREATE FUNCTION finance_book_layout_guard() RETURNS trigger
SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'a layout of a legal book is never changed or deleted: write a new version' USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_finance_book_layouts_guard
  BEFORE UPDATE OR DELETE ON "finance_book_layouts"
  FOR EACH ROW EXECUTE FUNCTION finance_book_layout_guard();
CREATE TRIGGER trg_finance_book_layouts_no_truncate
  BEFORE TRUNCATE ON "finance_book_layouts"
  FOR EACH STATEMENT EXECUTE FUNCTION finance_book_layout_guard();

-- CreateTable
CREATE TABLE "finance_book_snapshots" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "period_id" TEXT NOT NULL,
    "book_kind" TEXT NOT NULL,
    "layout_version" INTEGER NOT NULL,
    "closed_at" TIMESTAMP(3) NOT NULL,
    "book" JSONB NOT NULL,
    "content_sha256" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_book_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "finance_book_snapshots_key" ON "finance_book_snapshots"("organization_id", "period_id", "book_kind", "layout_version", "closed_at");
CREATE INDEX "finance_book_snapshots_organization_id_created_at_idx" ON "finance_book_snapshots"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "finance_book_snapshots" ADD CONSTRAINT "finance_book_snapshots_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finance_book_snapshots" ADD CONSTRAINT "finance_book_snapshots_organization_id_period_id_fkey" FOREIGN KEY ("organization_id", "period_id") REFERENCES "fiscal_periods"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "finance_book_snapshots" ADD CONSTRAINT chk_finance_book_snapshots_kind CHECK (book_kind IN ('sales_taxpayers', 'sales_consumers', 'purchases'));
ALTER TABLE "finance_book_snapshots" ADD CONSTRAINT chk_finance_book_snapshots_version CHECK (layout_version >= 0);
ALTER TABLE "finance_book_snapshots" ADD CONSTRAINT chk_finance_book_snapshots_sha CHECK (content_sha256 ~ '^[0-9a-f]{64}$');

-- A frozen book is evidence of what was handed over for a closed month: never changed, never deleted
CREATE FUNCTION finance_book_snapshot_guard() RETURNS trigger
SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'a frozen legal book is never changed or deleted' USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_finance_book_snapshots_guard
  BEFORE UPDATE OR DELETE ON "finance_book_snapshots"
  FOR EACH ROW EXECUTE FUNCTION finance_book_snapshot_guard();
CREATE TRIGGER trg_finance_book_snapshots_no_truncate
  BEFORE TRUNCATE ON "finance_book_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION finance_book_snapshot_guard();
