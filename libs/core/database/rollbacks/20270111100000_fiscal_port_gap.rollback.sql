-- Rolls back 20270111100000_fiscal_port_gap. It refuses to run while a document holds a number of a series, or a series exists: those
-- numbers are legal numbering (an accepted document keeps its number for ever) and dropping the columns would lose which number of which
-- series each document took. Export fiscal_sequences and the correlative columns of fiscal_documents and decide with the accountant first.
-- The contact and the point of sale of the issuer are configuration and are dropped (the owner enters them again). Run it before the code
-- that reads the columns is brought back. Safe to run twice.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'fiscal_documents' AND column_name = 'correlative')
     AND EXISTS (SELECT 1 FROM fiscal_documents WHERE correlative IS NOT NULL) THEN
    RAISE EXCEPTION 'fiscal documents hold numbers of a series: export them before rolling back';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'fiscal_sequences')
     AND EXISTS (SELECT 1 FROM fiscal_sequences) THEN
    RAISE EXCEPTION 'fiscal series exist: export them before rolling back';
  END IF;
END
$$;
DROP INDEX IF EXISTS "fiscal_documents_organization_id_correlative_scope_key_corr_key";
ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS chk_fiscal_documents_correlative;
ALTER TABLE fiscal_documents DROP COLUMN IF EXISTS correlative_scope_key;
ALTER TABLE fiscal_documents DROP COLUMN IF EXISTS correlative;
DROP TABLE IF EXISTS fiscal_sequences;
DROP FUNCTION IF EXISTS fiscal_sequence_guard();
ALTER TABLE fiscal_issuers DROP COLUMN IF EXISTS email;
ALTER TABLE fiscal_issuers DROP COLUMN IF EXISTS phone;
ALTER TABLE fiscal_issuers DROP COLUMN IF EXISTS point_of_sale_code;
ALTER TABLE fiscal_issuers DROP COLUMN IF EXISTS establishment_type;

-- The guard as 20261223100000_fiscal_credit_notes made it
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
COMMIT;
