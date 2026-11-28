-- What each exported annex of purchases held (D4b-2). The annex declares what the supplier's documents said on the day it was taken out; the row of a
-- document (purchase_receipt_documents) can still change afterwards, so the platform keeps a constancia of each export: the file and its digest,
-- and, for every receipt of the month, the digest of what decided its place in the file. Only ids, counts and digests: never a name, a tax id
-- or a figure. A later change to a document that an export held is refused unless it is a rectification, and exporting the month again says
-- how many receipts moved since the last export.
CREATE TABLE "fiscal_annex_exports" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "annex_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "row_count" INTEGER NOT NULL,
    "content_sha256" TEXT NOT NULL,
    "sources_sha256" TEXT NOT NULL,
    "exported_by" TEXT NOT NULL,
    "exported_at" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),

    CONSTRAINT "fiscal_annex_exports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_fiscal_annex_exports_period" CHECK ("month" BETWEEN 1 AND 12 AND "year" BETWEEN 2000 AND 2200),
    CONSTRAINT "chk_fiscal_annex_exports_rows" CHECK ("row_count" >= 0),
    CONSTRAINT "chk_fiscal_annex_exports_digests" CHECK (
      "content_sha256" ~ '^[0-9a-f]{64}$' AND "sources_sha256" ~ '^[0-9a-f]{64}$'
    )
);

CREATE UNIQUE INDEX "fiscal_annex_exports_organization_id_id_key" ON "fiscal_annex_exports"("organization_id", "id");
CREATE INDEX "fiscal_annex_exports_organization_id_annex_id_year_month_idx"
    ON "fiscal_annex_exports"("organization_id", "annex_id", "year", "month", "exported_at");

ALTER TABLE "fiscal_annex_exports" ADD CONSTRAINT "fiscal_annex_exports_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "fiscal_annex_export_items" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "export_id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "source_sha256" TEXT NOT NULL,
    "included" BOOLEAN NOT NULL,

    CONSTRAINT "fiscal_annex_export_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_fiscal_annex_export_items_digest" CHECK ("source_sha256" ~ '^[0-9a-f]{64}$')
);

-- A receipt is once in an export; the receipts an export held are what a later change to their document is checked against
CREATE UNIQUE INDEX "fiscal_annex_export_items_organization_id_export_id_receipt_id_key"
    ON "fiscal_annex_export_items"("organization_id", "export_id", "receipt_id");
CREATE INDEX "fiscal_annex_export_items_organization_id_receipt_id_idx"
    ON "fiscal_annex_export_items"("organization_id", "receipt_id");

ALTER TABLE "fiscal_annex_export_items" ADD CONSTRAINT "fiscal_annex_export_items_export_fkey"
    FOREIGN KEY ("organization_id", "export_id") REFERENCES "fiscal_annex_exports"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fiscal_annex_export_items" ADD CONSTRAINT "fiscal_annex_export_items_receipt_fkey"
    FOREIGN KEY ("organization_id", "receipt_id") REFERENCES "purchase_receipts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The constancia is append-only: the application roles can read and add, never change, remove or empty it (the privileges), and nobody else
-- either, the owner of the table included (the triggers). The worker only reads it: nothing it runs exports an annex.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE fiscal_annex_exports, fiscal_annex_export_items FROM platform_app, platform_worker;
REVOKE INSERT ON TABLE fiscal_annex_exports, fiscal_annex_export_items FROM platform_worker;

CREATE FUNCTION forbid_fiscal_annex_export_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'FISCAL_ANNEX_EXPORT_IMMUTABLE: % of % is not allowed, the constancia of an export is append-only', TG_OP, TG_TABLE_NAME;
END $$;

CREATE TRIGGER trg_fiscal_annex_exports_append_only BEFORE UPDATE OR DELETE ON fiscal_annex_exports
  FOR EACH ROW EXECUTE FUNCTION forbid_fiscal_annex_export_change();
CREATE TRIGGER trg_fiscal_annex_exports_no_truncate BEFORE TRUNCATE ON fiscal_annex_exports
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_fiscal_annex_export_change();
CREATE TRIGGER trg_fiscal_annex_export_items_append_only BEFORE UPDATE OR DELETE ON fiscal_annex_export_items
  FOR EACH ROW EXECUTE FUNCTION forbid_fiscal_annex_export_change();
CREATE TRIGGER trg_fiscal_annex_export_items_no_truncate BEFORE TRUNCATE ON fiscal_annex_export_items
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_fiscal_annex_export_change();

SELECT rls_apply_policy('fiscal_annex_exports', 'organization');
SELECT rls_apply_policy('fiscal_annex_export_items', 'organization');
