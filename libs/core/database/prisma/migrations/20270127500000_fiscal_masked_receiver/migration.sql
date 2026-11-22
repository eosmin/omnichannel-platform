-- Step 7.3-S11b-2: the receiver of a fiscal document as the lists show it. The name (first letter of each word) and the tax id (last
-- characters) are kept MASKED and in the clear beside the sealed receiver, so a page of documents opens no sealed value; the mask is the one
-- the screens already show, never the value. receiver_masked_at is NULL until the mask is calculated: a row with no mask yet is opened as
-- before, and the nightly job of the re-seal calculates the missing ones through the door of the guard (fiscal_mask_document, worker only).
-- AlterTable
ALTER TABLE "fiscal_documents" ADD COLUMN "receiver_name_masked" TEXT, ADD COLUMN "receiver_tax_id_masked" TEXT, ADD COLUMN "receiver_masked_at" TIMESTAMP(3);

-- The rows the job still has to calculate (a document with a mask never appears here)
CREATE INDEX "fiscal_documents_receiver_unmasked_idx" ON "fiscal_documents"("organization_id", "id") WHERE "receiver_masked_at" IS NULL;

-- The guard of a decided document: the door of the re-seal also lets the three masked columns change
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
    -- changes the two sealed columns and the three masked ones, and nothing else. The door is open only for a statement that runs as the owner of the function that
    -- opens it (fiscal_reseal_document, a SECURITY DEFINER callable by the worker): another role that sets the same setting by hand still
    -- runs as itself, so the whole row is compared as before. The row is compared whole, so a column added later is never forgotten.
    IF fiscal_reseal_door_open() THEN
      IF NEW.status IS DISTINCT FROM OLD.status
         OR (to_jsonb(NEW) - 'receiver_encrypted' - 'built_payload_encrypted' - 'receiver_name_masked' - 'receiver_tax_id_masked' - 'receiver_masked_at' - 'updated_at')
            IS DISTINCT FROM (to_jsonb(OLD) - 'receiver_encrypted' - 'built_payload_encrypted' - 'receiver_name_masked' - 'receiver_tax_id_masked' - 'receiver_masked_at' - 'updated_at') THEN
        RAISE EXCEPTION 'a re-seal changes only the sealed and masked columns' USING ERRCODE = 'integrity_constraint_violation';
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

-- The re-seal of one decided or live document, in one statement that the guard recognises. The caller (the worker) has already opened the
-- old value, sealed it again with the current key and checked that the new value opens to the same text; here the swap is compare-and-swap
-- (the old bytes are in the WHERE), so a row that changed meanwhile is left alone and the call says so. The organization must be one of the
-- context of the caller. The setting that opens the door of the guard lives only inside this function: it is set, the statement runs, and it
-- is put back before the function returns.

-- Writes the mask of one document whose mask is not calculated yet, by compare-and-swap (the receiver it was calculated from is in the WHERE and
-- the mask must still be missing). Only the worker calls it, for an organization in its context; it uses the door of the guard.
CREATE FUNCTION fiscal_mask_document(p_organization_id text, p_id text, p_receiver bytea, p_name text, p_tax_id text) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    changed integer;
  BEGIN
    IF p_organization_id IS NULL OR NOT (p_organization_id = ANY (public.app_organization_ids())) THEN
      RAISE EXCEPTION 'the organization is not in the context of the caller' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_receiver IS NULL THEN
      RAISE EXCEPTION 'a mask is calculated from a receiver' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM pg_catalog.set_config('app.fiscal_reseal', 'on', true);
    UPDATE public.fiscal_documents
       SET receiver_name_masked = p_name, receiver_tax_id_masked = p_tax_id, receiver_masked_at = pg_catalog.now()
     WHERE id = p_id AND organization_id = p_organization_id AND receiver_encrypted = p_receiver AND receiver_masked_at IS NULL;
    GET DIAGNOSTICS changed = ROW_COUNT;
    PERFORM pg_catalog.set_config('app.fiscal_reseal', 'off', true);
    RETURN changed = 1;
  END
  $$;
REVOKE EXECUTE ON FUNCTION fiscal_mask_document(text, text, bytea, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fiscal_mask_document(text, text, bytea, text, text) TO platform_worker;
