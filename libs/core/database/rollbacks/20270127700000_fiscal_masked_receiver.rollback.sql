-- Rolls back 20270127700000_fiscal_masked_receiver: drops the mask function and the three masked columns and gives the guard the form of
-- 20270127400000. Safe to run twice. The masks are derived (the sealed receiver holds the truth), so nothing is lost; the lists open the
-- sealed receiver again. ORDER: roll the code back with this script or after it (the code reads the columns).
BEGIN;
CREATE OR REPLACE FUNCTION fiscal_document_guard() RETURNS trigger
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a fiscal document is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status IN ('accepted', 'voided') AND NEW.claim_token IS NOT NULL THEN
    RAISE EXCEPTION 'a decided fiscal document holds no claim token' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('accepted', 'voided') THEN
    -- The re-seal of a rotation of the key (Step 7.3-S11b): the one door that lets a DECIDED document (accepted or voided) change, and it
    -- changes the two sealed columns and nothing else. The door is open only for a statement that runs as the owner of the function that
    -- opens it (fiscal_reseal_document, a SECURITY DEFINER callable by the worker): another role that sets the same setting by hand still
    -- runs as itself, so the whole row is compared as before. The row is compared whole, so a column added later is never forgotten.
    IF fiscal_reseal_door_open() THEN
      IF NEW.status IS DISTINCT FROM OLD.status
         OR (to_jsonb(NEW) - 'receiver_encrypted' - 'built_payload_encrypted' - 'updated_at')
            IS DISTINCT FROM (to_jsonb(OLD) - 'receiver_encrypted' - 'built_payload_encrypted' - 'updated_at') THEN
        RAISE EXCEPTION 'a re-seal changes only the sealed columns' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.status = 'voided' THEN
      RAISE EXCEPTION 'a voided fiscal document does not change' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- An accepted row stays accepted only to hold or free the claim of an invalidation: the whole row is compared, so a column that is
    -- added later is never forgotten
    IF NEW.status = 'accepted' THEN
      IF (to_jsonb(NEW) - 'void_claim_key' - 'void_claim_until' - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'void_claim_key' - 'void_claim_until' - 'updated_at') THEN
        RAISE EXCEPTION 'an accepted fiscal document is immutable' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
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

DROP FUNCTION IF EXISTS fiscal_mask_document(text, text, bytea, text, text);
DROP INDEX IF EXISTS fiscal_documents_receiver_unmasked_idx;
ALTER TABLE fiscal_documents DROP COLUMN IF EXISTS receiver_name_masked, DROP COLUMN IF EXISTS receiver_tax_id_masked, DROP COLUMN IF EXISTS receiver_masked_at;
COMMIT;
