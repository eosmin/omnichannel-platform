-- Step 4B.7c-1 (TDD_18 §8.1): the fiscal port gets what a real provider needs and the simulator did not.
--  * the issuer keeps the kind of establishment, the code of the point of sale and its contact (all optional: nothing existing changes);
--  * a series of correlatives per provider, environment and what the provider's manifest declares (`fiscal_sequences`), and the number a
--    document took in its series (`fiscal_documents.correlative`, `.correlative_scope_key`).
-- No document is renumbered and none is touched: the new columns of a document are NULL for every document that exists, and a provider
-- that declares no scope keeps numbering by `sequence_number` as before. An accepted document keeps its number for ever: the guard below
-- adds the two columns to what no longer changes.

-- AlterTable
ALTER TABLE "fiscal_issuers" ADD COLUMN "establishment_type" TEXT;
ALTER TABLE "fiscal_issuers" ADD COLUMN "point_of_sale_code" TEXT;
ALTER TABLE "fiscal_issuers" ADD COLUMN "phone" TEXT;
ALTER TABLE "fiscal_issuers" ADD COLUMN "email" TEXT;

-- CreateTable
CREATE TABLE "fiscal_sequences" (
    "organization_id" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "next_value" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiscal_sequences_pkey" PRIMARY KEY ("organization_id","scope_key")
);

-- AddForeignKey
ALTER TABLE "fiscal_sequences" ADD CONSTRAINT "fiscal_sequences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A counter starts at 1 and is never below it; it stays inside the INTEGER of the document (a scope that reaches the end stops in the
-- code, it never wraps)
ALTER TABLE "fiscal_sequences" ADD CONSTRAINT "chk_fiscal_sequences_next_value" CHECK ("next_value" >= 1);

-- A counter only moves forward and is never deleted: deleting or lowering one would hand out a number twice
CREATE FUNCTION fiscal_sequence_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a fiscal series is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.scope_key IS DISTINCT FROM OLD.scope_key
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.next_value < OLD.next_value THEN
    RAISE EXCEPTION 'a fiscal series only moves forward' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_fiscal_sequences_guard
BEFORE UPDATE OR DELETE ON fiscal_sequences
FOR EACH ROW EXECUTE FUNCTION fiscal_sequence_guard();

REVOKE DELETE, TRUNCATE ON TABLE fiscal_sequences FROM platform_app, platform_worker;

-- AlterTable
ALTER TABLE "fiscal_documents" ADD COLUMN "correlative" INTEGER;
ALTER TABLE "fiscal_documents" ADD COLUMN "correlative_scope_key" TEXT;

-- A number and the series it belongs to come together or not at all, and are never below 1
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "chk_fiscal_documents_correlative" CHECK (
  (("correlative" IS NULL) = ("correlative_scope_key" IS NULL))
  AND ("correlative" IS NULL OR "correlative" >= 1)
);

-- CreateIndex: one number of a series for one document (two NULLs never collide, so a document with no number yet is free)
CREATE UNIQUE INDEX "fiscal_documents_organization_id_correlative_scope_key_corr_key" ON "fiscal_documents"("organization_id", "correlative_scope_key", "correlative");

-- The guard of an accepted document: the number in its series is part of what no longer changes (the function of 20261223100000, with the
-- two columns added)
CREATE OR REPLACE FUNCTION fiscal_document_guard() RETURNS trigger
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a fiscal document is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('accepted', 'voided') THEN
    IF OLD.status = 'voided' THEN
      RAISE EXCEPTION 'a voided fiscal document does not change' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status <> 'voided'
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.store_id IS DISTINCT FROM OLD.store_id
       OR NEW.order_id IS DISTINCT FROM OLD.order_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.return_id IS DISTINCT FROM OLD.return_id
       OR NEW.parent_document_id IS DISTINCT FROM OLD.parent_document_id
       OR NEW.replaces_document_id IS DISTINCT FROM OLD.replaces_document_id
       OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
       OR NEW.sequence_number IS DISTINCT FROM OLD.sequence_number
       OR NEW.correlative IS DISTINCT FROM OLD.correlative
       OR NEW.correlative_scope_key IS DISTINCT FROM OLD.correlative_scope_key
       OR NEW.document_type IS DISTINCT FROM OLD.document_type
       OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
       OR NEW.environment IS DISTINCT FROM OLD.environment
       OR NEW.external_number IS DISTINCT FROM OLD.external_number
       OR NEW.provider_data IS DISTINCT FROM OLD.provider_data
       OR NEW.issuer_snapshot IS DISTINCT FROM OLD.issuer_snapshot
       OR NEW.lines_snapshot IS DISTINCT FROM OLD.lines_snapshot
       OR NEW.receiver_encrypted IS DISTINCT FROM OLD.receiver_encrypted
       OR NEW.built_payload_encrypted IS DISTINCT FROM OLD.built_payload_encrypted
       OR NEW.response IS DISTINCT FROM OLD.response
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.total_cents IS DISTINCT FROM OLD.total_cents
       OR NEW.tax_cents IS DISTINCT FROM OLD.tax_cents
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason
       OR NEW.submission IS DISTINCT FROM OLD.submission
       OR NEW.attempts IS DISTINCT FROM OLD.attempts
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
      RAISE EXCEPTION 'an accepted fiscal document is immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
