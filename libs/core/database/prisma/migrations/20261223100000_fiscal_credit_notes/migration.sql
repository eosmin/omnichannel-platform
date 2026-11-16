-- Step 4B.7b (TDD_18 §8.3): the credit note of a return, linked to the sale document it cancels (part of), and the sale document made again
-- after the one before was voided. Additive: every document that exists stays a sale document, with no backfill. Core keeps the relation
-- between the documents; what a credit note is, legally, is the provider's.

ALTER TABLE "fiscal_documents" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'sale';
ALTER TABLE "fiscal_documents" ADD COLUMN "return_id" TEXT;
ALTER TABLE "fiscal_documents" ADD COLUMN "parent_document_id" TEXT;
ALTER TABLE "fiscal_documents" ADD COLUMN "replaces_document_id" TEXT;

-- One document per order is no longer the rule: one LIVE sale document per order (a voided one leaves room for its replacement), one live
-- credit note per return, and one per order that came back as a whole with no return row
DROP INDEX "fiscal_documents_organization_id_order_id_key";
CREATE INDEX "fiscal_documents_organization_id_order_id_idx" ON "fiscal_documents"("organization_id", "order_id");
CREATE INDEX "fiscal_documents_return_id_idx" ON "fiscal_documents"("return_id");
CREATE INDEX "fiscal_documents_parent_document_id_idx" ON "fiscal_documents"("parent_document_id");
CREATE INDEX "fiscal_documents_replaces_document_id_idx" ON "fiscal_documents"("replaces_document_id");
CREATE UNIQUE INDEX "uq_fiscal_documents_live_sale" ON "fiscal_documents"("organization_id", "order_id")
  WHERE kind = 'sale' AND status <> 'voided';
CREATE UNIQUE INDEX "uq_fiscal_documents_live_credit_note_of_return" ON "fiscal_documents"("organization_id", "return_id")
  WHERE kind = 'credit_note' AND return_id IS NOT NULL AND status <> 'voided';
CREATE UNIQUE INDEX "uq_fiscal_documents_live_credit_note_of_order" ON "fiscal_documents"("organization_id", "order_id")
  WHERE kind = 'credit_note' AND return_id IS NULL AND status <> 'voided';
-- A document is replaced once: two replacements of the same voided document would be two sale documents for one sale
CREATE UNIQUE INDEX "uq_fiscal_documents_replaces" ON "fiscal_documents"("replaces_document_id") WHERE replaces_document_id IS NOT NULL;

ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "order_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_parent_document_id_fkey" FOREIGN KEY ("parent_document_id") REFERENCES "fiscal_documents"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_replaces_document_id_fkey" FOREIGN KEY ("replaces_document_id") REFERENCES "fiscal_documents"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- The values of FiscalDocumentKind and what each kind may carry: a credit note names the document it cancels, only a credit note names a
-- return, only a sale document replaces another
ALTER TABLE "fiscal_documents" ADD CONSTRAINT chk_fiscal_documents_kind CHECK (kind IN ('sale', 'credit_note'));
ALTER TABLE "fiscal_documents" ADD CONSTRAINT chk_fiscal_documents_credit_note_parent CHECK ((kind = 'credit_note') = (parent_document_id IS NOT NULL));
ALTER TABLE "fiscal_documents" ADD CONSTRAINT chk_fiscal_documents_return_only_credit_note CHECK (return_id IS NULL OR kind = 'credit_note');
ALTER TABLE "fiscal_documents" ADD CONSTRAINT chk_fiscal_documents_replaces_only_sale CHECK (replaces_document_id IS NULL OR kind = 'sale');

-- The guard of an accepted document: the new columns are part of what no longer changes
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

-- The scope: the return, the original and the document that is replaced belong to the order, the store and the organization of the
-- document, and are of the kind the relation needs. Checked on insert and when one of them is written again (a retry of a credit note
-- names the sale document that is live now).
CREATE OR REPLACE FUNCTION check_fiscal_document_scope() RETURNS trigger
SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM orders o JOIN stores s ON s.id = o.store_id
    WHERE o.id = NEW.order_id AND s.id = NEW.store_id AND s.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'the order of a fiscal document belongs to its store and its organization' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.return_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM order_returns r WHERE r.id = NEW.return_id AND r.order_id = NEW.order_id AND r.store_id = NEW.store_id
  ) THEN
    RAISE EXCEPTION 'the return of a credit note belongs to the order and the store of the document' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.parent_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM fiscal_documents p
    WHERE p.id = NEW.parent_document_id AND p.organization_id = NEW.organization_id AND p.order_id = NEW.order_id AND p.kind = 'sale'
  ) THEN
    RAISE EXCEPTION 'the original of a credit note is a sale document of the same order' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.replaces_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM fiscal_documents p
    WHERE p.id = NEW.replaces_document_id AND p.organization_id = NEW.organization_id AND p.order_id = NEW.order_id
      AND p.kind = 'sale' AND p.status = 'voided'
  ) THEN
    RAISE EXCEPTION 'a fiscal document replaces a voided sale document of the same order' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER trg_fiscal_documents_scope ON fiscal_documents;
CREATE TRIGGER trg_fiscal_documents_scope
BEFORE INSERT OR UPDATE OF organization_id, store_id, order_id, return_id, parent_document_id, replaces_document_id ON fiscal_documents
FOR EACH ROW EXECUTE FUNCTION check_fiscal_document_scope();
