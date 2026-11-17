-- Rolls back 20270114200000_fiscal_contingency. It refuses to run while any contingency exists or a document was made in one: those rows
-- say which documents were made without the authority's seal and when they had to be sent, which is legal evidence. Export
-- fiscal_contingencies and the contingency_id of fiscal_documents and decide with the accountant first. Run it before the code that reads
-- them is brought back. Safe to run twice.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'fiscal_documents' AND column_name = 'contingency_id')
     AND EXISTS (SELECT 1 FROM fiscal_documents WHERE contingency_id IS NOT NULL) THEN
    RAISE EXCEPTION 'fiscal documents were made in contingency: export them before rolling back';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'fiscal_contingencies')
     AND EXISTS (SELECT 1 FROM fiscal_contingencies) THEN
    RAISE EXCEPTION 'fiscal contingencies exist: export them before rolling back';
  END IF;
END
$$;
ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS fiscal_documents_contingency_id_fkey;
DROP INDEX IF EXISTS "fiscal_documents_contingency_id_idx";
ALTER TABLE fiscal_documents DROP COLUMN IF EXISTS contingency_id;
DROP TABLE IF EXISTS fiscal_contingencies;
DROP FUNCTION IF EXISTS fiscal_contingency_guard();

-- The guard as 20270111100000_fiscal_port_gap made it
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
COMMIT;
