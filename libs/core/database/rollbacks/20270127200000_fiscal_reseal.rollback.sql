-- Rolls back 20270127200000_fiscal_reseal: drops the re-seal function and gives the guard the form of 20270127100000. Safe to run twice.
-- ORDER: stop the re-seal (unset CREDENTIALS_ENCRYPTION_KEY_PREVIOUS) first, or roll the code back with this script; a value already
-- sealed again stays valid (it opens with the current key), so nothing is lost.
BEGIN;
CREATE OR REPLACE FUNCTION fiscal_document_guard() RETURNS trigger
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a fiscal document is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status IN ('accepted', 'voided') AND NEW.claim_token IS NOT NULL THEN
    RAISE EXCEPTION 'a decided fiscal document holds no claim token' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('accepted', 'voided') THEN
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

CREATE OR REPLACE FUNCTION fiscal_contingency_guard() RETURNS trigger
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
DROP FUNCTION IF EXISTS fiscal_reseal_contingency(text, text, bytea, bytea);
DROP FUNCTION IF EXISTS fiscal_reseal_document(text, text, bytea, bytea, bytea, bytea);
DROP FUNCTION IF EXISTS fiscal_reseal_door_open();
DROP FUNCTION IF EXISTS fiscal_reseal_shape_ok(bytea);
COMMIT;
