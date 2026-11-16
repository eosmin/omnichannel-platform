-- Rolls back 20261223100000_fiscal_credit_notes. It refuses to run while a credit note or a replacement exists: they are legal evidence and
-- dropping their columns would destroy the relation to the document they cancel or replace. Export them and decide with the accountant first.
-- Safe to run twice.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'fiscal_documents' AND column_name = 'kind')
     AND EXISTS (SELECT 1 FROM fiscal_documents WHERE kind <> 'sale' OR replaces_document_id IS NOT NULL) THEN
    RAISE EXCEPTION 'fiscal credit notes or replacements exist: export them before rolling back';
  END IF;
END
$$;
DROP TRIGGER IF EXISTS trg_fiscal_documents_scope ON fiscal_documents;
DROP INDEX IF EXISTS uq_fiscal_documents_replaces;
DROP INDEX IF EXISTS uq_fiscal_documents_live_credit_note_of_order;
DROP INDEX IF EXISTS uq_fiscal_documents_live_credit_note_of_return;
DROP INDEX IF EXISTS uq_fiscal_documents_live_sale;
DROP INDEX IF EXISTS fiscal_documents_replaces_document_id_idx;
DROP INDEX IF EXISTS fiscal_documents_parent_document_id_idx;
DROP INDEX IF EXISTS fiscal_documents_return_id_idx;
DROP INDEX IF EXISTS fiscal_documents_organization_id_order_id_idx;
ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS chk_fiscal_documents_replaces_only_sale;
ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS chk_fiscal_documents_return_only_credit_note;
ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS chk_fiscal_documents_credit_note_parent;
ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS chk_fiscal_documents_kind;
ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS fiscal_documents_replaces_document_id_fkey;
ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS fiscal_documents_parent_document_id_fkey;
ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS fiscal_documents_return_id_fkey;
ALTER TABLE fiscal_documents DROP COLUMN IF EXISTS replaces_document_id;
ALTER TABLE fiscal_documents DROP COLUMN IF EXISTS parent_document_id;
ALTER TABLE fiscal_documents DROP COLUMN IF EXISTS return_id;
ALTER TABLE fiscal_documents DROP COLUMN IF EXISTS kind;
CREATE UNIQUE INDEX IF NOT EXISTS "fiscal_documents_organization_id_order_id_key" ON "fiscal_documents"("organization_id", "order_id");

-- The guard and the scope as 20261222100000_fiscal_documents made them
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


CREATE OR REPLACE FUNCTION check_fiscal_document_scope() RETURNS trigger
SET search_path = public, pg_temp AS $$
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
COMMIT;
