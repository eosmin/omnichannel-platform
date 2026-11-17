-- Step 4B.7c-7 (TDD_18 §8.3): contingency. While the authority cannot be reached an issuer may go on making documents in a deferred model:
-- the document is made, signed and kept, and sent after the event that reports the contingency was accepted.
--  * `fiscal_contingencies`: one row per contingency, at most one OPEN per organization, never deleted, only moving forward;
--  * `fiscal_documents.contingency_id`: the contingency a document was made in. NULL for every document that exists. Once a document is
--    accepted (or voided) the column is part of what no longer changes (the guard below, the function of 20270111100000 with it added).

-- CreateTable
CREATE TABLE "fiscal_contingencies" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "motive" TEXT,
    "responsible_encrypted" BYTEA,
    "event_code" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "reported_at" TIMESTAMP(3),
    "window_ends_at" TIMESTAMP(3),
    "warned_at" TIMESTAMP(3),
    "provider_data" JSONB,
    "response" JSONB,
    "report_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_report_error" TEXT,
    "opened_by" TEXT,
    "closed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiscal_contingencies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fiscal_contingencies_organization_id_status_idx" ON "fiscal_contingencies"("organization_id", "status");

-- AddForeignKey
ALTER TABLE "fiscal_contingencies" ADD CONSTRAINT "fiscal_contingencies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The states, and what each one has: an open contingency has not ended nor been reported; a closed one has ended; a reported one has both
-- and the window it opened
ALTER TABLE "fiscal_contingencies" ADD CONSTRAINT "chk_fiscal_contingencies_state" CHECK (
  ("status" = 'open' AND "ended_at" IS NULL AND "reported_at" IS NULL)
  OR ("status" = 'closed' AND "ended_at" IS NOT NULL AND "reported_at" IS NULL)
  OR ("status" = 'reported' AND "ended_at" IS NOT NULL AND "reported_at" IS NOT NULL AND "window_ends_at" IS NOT NULL)
);
ALTER TABLE "fiscal_contingencies" ADD CONSTRAINT "chk_fiscal_contingencies_origin" CHECK ("origin" IN ('user', 'system'));
ALTER TABLE "fiscal_contingencies" ADD CONSTRAINT "chk_fiscal_contingencies_attempts" CHECK ("report_attempts" >= 0);

-- At most one open contingency per organization: two would report the same documents twice
CREATE UNIQUE INDEX "uq_fiscal_contingencies_one_open" ON "fiscal_contingencies"("organization_id") WHERE "status" = 'open';
-- The identifier of the event is the event's: two contingencies never share one
CREATE UNIQUE INDEX "fiscal_contingencies_event_code_key" ON "fiscal_contingencies"("event_code");

-- A contingency is never deleted and only moves forward (open, closed, reported); what it was made with never changes
CREATE FUNCTION fiscal_contingency_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a fiscal contingency is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.event_code IS DISTINCT FROM OLD.event_code
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.opened_by IS DISTINCT FROM OLD.opened_by THEN
    RAISE EXCEPTION 'a fiscal contingency keeps what it was opened with' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (OLD.status = 'closed' AND NEW.status = 'open')
     OR (OLD.status = 'reported' AND NEW.status <> 'reported')
     OR (OLD.status = 'open' AND NEW.status = 'reported') THEN
    RAISE EXCEPTION 'a fiscal contingency only moves forward' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'reported' AND (
       NEW.ended_at IS DISTINCT FROM OLD.ended_at
       OR NEW.reported_at IS DISTINCT FROM OLD.reported_at
       OR NEW.window_ends_at IS DISTINCT FROM OLD.window_ends_at
       OR NEW.provider_data IS DISTINCT FROM OLD.provider_data
       OR NEW.response IS DISTINCT FROM OLD.response
       OR NEW.responsible_encrypted IS DISTINCT FROM OLD.responsible_encrypted
       OR NEW.motive IS DISTINCT FROM OLD.motive) THEN
    RAISE EXCEPTION 'a reported fiscal contingency does not change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_fiscal_contingencies_guard
BEFORE UPDATE OR DELETE ON fiscal_contingencies
FOR EACH ROW EXECUTE FUNCTION fiscal_contingency_guard();

REVOKE DELETE, TRUNCATE ON TABLE fiscal_contingencies FROM platform_app, platform_worker;

-- AlterTable
ALTER TABLE "fiscal_documents" ADD COLUMN "contingency_id" TEXT;

-- CreateIndex
CREATE INDEX "fiscal_documents_contingency_id_idx" ON "fiscal_documents"("contingency_id");

-- AddForeignKey
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_contingency_id_fkey" FOREIGN KEY ("contingency_id") REFERENCES "fiscal_contingencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The guard of an accepted document, with the contingency added to what no longer changes
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
       OR NEW.contingency_id IS DISTINCT FROM OLD.contingency_id
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
      RAISE EXCEPTION 'an accepted fiscal document is immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
