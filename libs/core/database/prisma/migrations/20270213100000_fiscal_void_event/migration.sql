-- D13b-2b-1: the signed event of an invalidation, kept sealed. The authority's answer to an invalidation (`void_response`) holds its seal but not the
-- event the issuer signed and sent, and the receiver is owed that event with the seal, as it was signed (Normativa DTE v2.0, apartado 11). The event
-- and its signature are sealed with the credentials key like the other payloads of the document and written by the very statement that makes the
-- document VOIDED, so an attempt the authority refused (or one answered by a consultation, which has no signature of its own) never leaves one.
-- The table is already tenant-scoped and under row-level security: a column adds no policy of its own.
-- Rollback: rollbacks/20270213100000_fiscal_void_event.rollback.sql
-- AlterTable
ALTER TABLE "fiscal_documents" ADD COLUMN "void_event_encrypted" BYTEA;

-- Only a voided document holds one (a live document never has an event of its own)
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_void_event_encrypted_chk"
  CHECK ("void_event_encrypted" IS NULL OR "status" = 'voided');

-- The guard of a decided document: the whole function as it stood in 20270210100000, with ONE change: the re-seal of a rotation of the key may also
-- swap the new sealed column (the voiding statement needs no change: the voided branch compares an explicit list that does not have it, as with
-- `void_response`, and a voided row never changes afterwards except through that door).
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
    -- changes the three sealed columns and the three masked ones, and nothing else. The door is open only for a statement that runs as the owner of the function that
    -- opens it (fiscal_reseal_document, a SECURITY DEFINER callable by the worker): another role that sets the same setting by hand still
    -- runs as itself, so the whole row is compared as before. The row is compared whole, so a column added later is never forgotten.
    IF fiscal_reseal_door_open() THEN
      IF NEW.status IS DISTINCT FROM OLD.status
         OR (to_jsonb(NEW) - 'receiver_encrypted' - 'built_payload_encrypted' - 'void_event_encrypted' - 'receiver_name_masked' - 'receiver_tax_id_masked' - 'receiver_masked_at' - 'updated_at')
            IS DISTINCT FROM (to_jsonb(OLD) - 'receiver_encrypted' - 'built_payload_encrypted' - 'void_event_encrypted' - 'receiver_name_masked' - 'receiver_tax_id_masked' - 'receiver_masked_at' - 'updated_at') THEN
        RAISE EXCEPTION 'a re-seal changes only the sealed and masked columns' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.status = 'voided' THEN
      RAISE EXCEPTION 'a voided fiscal document does not change' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- An accepted row stays accepted only to carry the state of the invalidation of the document, and nothing else. The columns it may change
    -- are listed here, ONE LIST for both sides of the comparison (add a column of the invalidation to it, never to a second place):
    --   void_claim_key, void_claim_until          the claim of the invalidation in flight (D14b)
    --   void_rejected_at, void_rejection_warned_at  the moment the authority refused it and the moment the person was told (D14b)
    --   void_event_code, void_event_at            the generation code and the moment of the event, fixed at its first attempt (D14c)
    --   updated_at
    -- The whole row is compared, so a column that is added later is never forgotten (it is immutable until it is listed).
    IF NEW.status = 'accepted' THEN
      IF (to_jsonb(NEW) - 'void_claim_key' - 'void_claim_until' - 'void_rejected_at' - 'void_rejection_warned_at' - 'void_event_code' - 'void_event_at' - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'void_claim_key' - 'void_claim_until' - 'void_rejected_at' - 'void_rejection_warned_at' - 'void_event_code' - 'void_event_at' - 'updated_at') THEN
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
       OR NEW.shipment_id IS DISTINCT FROM OLD.shipment_id
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
       OR NEW.receiver_name_masked IS DISTINCT FROM OLD.receiver_name_masked
       OR NEW.receiver_tax_id_masked IS DISTINCT FROM OLD.receiver_tax_id_masked
       OR NEW.receiver_masked_at IS DISTINCT FROM OLD.receiver_masked_at
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

-- The re-seal of the sealed event of one voided document, in one statement that the guard recognises (the same door as `fiscal_reseal_document`).
-- The caller (the worker) has opened the old value, sealed it again with the current key and checked that the new one opens to the same content;
-- the swap is compare-and-swap (the old bytes are in the WHERE), so a row that changed meanwhile is left alone and the call says so.
CREATE FUNCTION fiscal_reseal_void_event(p_organization_id text, p_id text, p_old bytea, p_new bytea) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    changed integer;
  BEGIN
    IF p_organization_id IS NULL OR NOT (p_organization_id = ANY (public.app_organization_ids())) THEN
      RAISE EXCEPTION 'the organization is not in the context of the caller' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_old IS NULL OR NOT public.fiscal_reseal_shape_ok(p_new) THEN
      RAISE EXCEPTION 'a re-seal needs a sealed event' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM pg_catalog.set_config('app.fiscal_reseal', 'on', true);
    UPDATE public.fiscal_documents
       SET void_event_encrypted = p_new
     WHERE id = p_id AND organization_id = p_organization_id AND void_event_encrypted = p_old;
    GET DIAGNOSTICS changed = ROW_COUNT;
    PERFORM pg_catalog.set_config('app.fiscal_reseal', 'off', true);
    RETURN changed = 1;
  END
  $$;
REVOKE EXECUTE ON FUNCTION fiscal_reseal_void_event(text, text, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fiscal_reseal_void_event(text, text, bytea, bytea) TO platform_worker;
