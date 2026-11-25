-- Rolls back 20270206100000_fiscal_remission_note: removes the guide a remission note backs, the kind and its checks, and restores the guard.
-- A fiscal document is never deleted (a trigger says it), so this FAILS, on purpose and with nothing changed, while a remission note exists:
-- those documents are what the authority has and must be kept (void them and keep the table, or restore a backup). Safe to run twice.
BEGIN;
ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS fiscal_documents_store_id_shipment_id_fkey;
DROP INDEX IF EXISTS fiscal_documents_store_id_shipment_id_idx;
DROP INDEX IF EXISTS uq_fiscal_documents_live_remission_of_shipment;
ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS chk_fiscal_documents_shipment_only_remission;
ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS chk_fiscal_documents_kind;
ALTER TABLE fiscal_documents ADD CONSTRAINT chk_fiscal_documents_kind CHECK (kind IN ('sale', 'credit_note'));
ALTER TABLE fiscal_documents DROP COLUMN IF EXISTS shipment_id;
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
    -- An accepted row stays accepted only to hold or free the claim of an invalidation, and to keep the moment the authority refused one and
    -- the moment the person was told: the whole row is compared, so a column that is added later is never forgotten
    IF NEW.status = 'accepted' THEN
      IF (to_jsonb(NEW) - 'void_claim_key' - 'void_claim_until' - 'void_rejected_at' - 'void_rejection_warned_at' - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'void_claim_key' - 'void_claim_until' - 'void_rejected_at' - 'void_rejection_warned_at' - 'updated_at') THEN
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
      AND p.kind = 'sale' AND p.status IN ('accepted', 'voided')
  ) THEN
    RAISE EXCEPTION 'a fiscal document replaces an accepted or voided sale document of the same order' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- A sale document that replaces nothing is the first one of its order: once the order has a sale document, voided or not, the next one is a
  -- replacement (the index above no longer sees an original once its replacement stands)
  IF TG_OP = 'INSERT' AND NEW.kind = 'sale' AND NEW.replaces_document_id IS NULL AND EXISTS (
    SELECT 1 FROM fiscal_documents s
    WHERE s.organization_id = NEW.organization_id AND s.order_id = NEW.order_id AND s.kind = 'sale' AND s.id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'the sale document of an order that has one is replaced, not made again' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
COMMIT;
