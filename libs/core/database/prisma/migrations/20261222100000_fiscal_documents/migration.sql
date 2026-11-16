-- Step 4B.7 (TDD_18 §8): the issuer of the organization and the fiscal documents of its sales. Core keeps the lifecycle and the link to
-- the ledger; the provider named in provider_id owns what is legal, so nothing here knows a country.

-- CreateTable
CREATE TABLE "fiscal_issuers" (
    "organization_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "tax_id" TEXT NOT NULL,
    "registration_id" TEXT,
    "address" JSONB NOT NULL,
    "activity_code" TEXT,
    "establishment_code" TEXT,
    "environment" TEXT NOT NULL,
    "issue_on" TEXT NOT NULL DEFAULT 'delivered',
    "credentials_encrypted" BYTEA,
    "next_sequence" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiscal_issuers_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "fiscal_documents" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "journal_entry_id" TEXT,
    "sequence_number" INTEGER NOT NULL,
    "document_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "external_number" TEXT,
    "provider_data" JSONB,
    "issuer_snapshot" JSONB NOT NULL,
    "lines_snapshot" JSONB NOT NULL,
    "receiver_encrypted" BYTEA NOT NULL,
    "built_payload_encrypted" BYTEA,
    "response" JSONB,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "total_cents" INTEGER NOT NULL,
    "tax_cents" INTEGER NOT NULL,
    "rejection_reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "submission" INTEGER NOT NULL DEFAULT 1,
    "void_reason" TEXT,
    "voided_by" TEXT,
    "voided_at" TIMESTAMP(3),
    "issued_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiscal_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_documents_organization_id_order_id_key" ON "fiscal_documents"("organization_id", "order_id");
CREATE UNIQUE INDEX "fiscal_documents_organization_id_sequence_number_key" ON "fiscal_documents"("organization_id", "sequence_number");
CREATE INDEX "fiscal_documents_organization_id_status_idx" ON "fiscal_documents"("organization_id", "status");
CREATE INDEX "fiscal_documents_store_id_idx" ON "fiscal_documents"("store_id");

-- AddForeignKey
ALTER TABLE "fiscal_issuers" ADD CONSTRAINT "fiscal_issuers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The values of the enums of core (FiscalDocumentStatus, FiscalEnvironment, FiscalIssueOn), and the amounts of a document
ALTER TABLE "fiscal_issuers" ADD CONSTRAINT chk_fiscal_issuers_environment CHECK (environment IN ('sandbox', 'production'));
ALTER TABLE "fiscal_issuers" ADD CONSTRAINT chk_fiscal_issuers_issue_on CHECK (issue_on IN ('delivered', 'shipped'));
ALTER TABLE "fiscal_issuers" ADD CONSTRAINT chk_fiscal_issuers_sequence CHECK (next_sequence >= 1);
ALTER TABLE "fiscal_documents" ADD CONSTRAINT chk_fiscal_documents_counters CHECK (attempts >= 0 AND submission >= 1);
ALTER TABLE "fiscal_documents" ADD CONSTRAINT chk_fiscal_documents_status CHECK (status IN ('draft', 'queued', 'submitted', 'accepted', 'rejected', 'voided'));
ALTER TABLE "fiscal_documents" ADD CONSTRAINT chk_fiscal_documents_amounts CHECK (total_cents >= 0 AND tax_cents >= 0 AND tax_cents <= total_cents);
ALTER TABLE "fiscal_documents" ADD CONSTRAINT chk_fiscal_documents_void CHECK ((status = 'voided') = (voided_at IS NOT NULL AND void_reason IS NOT NULL));

-- An accepted document is the legal evidence (TDD_18 §8.3): once accepted, nothing in it changes but the status to voided and the void
-- fields, and a document is never deleted. The service refuses first (FISCAL_DOCUMENT_IMMUTABLE); this is the floor under it.
CREATE FUNCTION fiscal_document_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a fiscal document is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('accepted', 'voided') THEN
    IF OLD.status = 'voided' THEN
      RAISE EXCEPTION 'a voided fiscal document does not change' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status <> 'voided'
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.store_id IS DISTINCT FROM OLD.store_id
       OR NEW.order_id IS DISTINCT FROM OLD.order_id
       OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
       OR NEW.sequence_number IS DISTINCT FROM OLD.sequence_number
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
       OR NEW.submission IS DISTINCT FROM OLD.submission
       OR NEW.attempts IS DISTINCT FROM OLD.attempts
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
      RAISE EXCEPTION 'an accepted fiscal document is immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fiscal_documents_guard
BEFORE UPDATE OR DELETE ON fiscal_documents
FOR EACH ROW EXECUTE FUNCTION fiscal_document_guard();

CREATE FUNCTION forbid_fiscal_document_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'the fiscal documents are never truncated' USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fiscal_documents_no_truncate
BEFORE TRUNCATE ON fiscal_documents
FOR EACH STATEMENT EXECUTE FUNCTION forbid_fiscal_document_truncate();

-- The store of a document is a store of its organization, and so is the order's
CREATE FUNCTION check_fiscal_document_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM orders o JOIN stores s ON s.id = o.store_id
    WHERE o.id = NEW.order_id AND s.id = NEW.store_id AND s.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'the order of a fiscal document belongs to its store and its organization' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fiscal_documents_scope
BEFORE INSERT ON fiscal_documents
FOR EACH ROW EXECUTE FUNCTION check_fiscal_document_scope();
