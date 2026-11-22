-- Step 7.3-S11b-1: the re-seal of the fiscal values after a rotation of CREDENTIALS_ENCRYPTION_KEY. A decided fiscal document (accepted or
-- voided) never changes; the one exception is the swap of its two sealed columns for the same text sealed with another key, done by
-- fiscal_reseal_document (the worker only). The guard below is the guard of 20270127100000 plus that one door.

-- Is the door of the re-seal open for this statement? The setting is on AND the statement runs as the owner of the re-seal functions (only
-- they turn the setting on, and only they run as the owner for a caller that is the worker). Another role that sets the name by hand
-- still runs as itself, so the answer is false for it. Not a SECURITY DEFINER: it only reads the setting and the catalog.
CREATE FUNCTION fiscal_reseal_door_open() RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT pg_catalog.current_setting('app.fiscal_reseal', true) = 'on'
       AND current_user = (
         SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
         WHERE p.oid = pg_catalog.to_regprocedure('public.fiscal_reseal_document(text, text, bytea, bytea, bytea, bytea)')
       )
  $$;

-- A sealed value as the cipher writes it: version 1 or 2, a 12 byte IV, at least the 16 byte tag
CREATE FUNCTION fiscal_reseal_shape_ok(p_sealed bytea) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp
  AS $$ SELECT p_sealed IS NOT NULL AND pg_catalog.length(p_sealed) >= 29 AND pg_catalog.get_byte(p_sealed, 0) IN (1, 2) $$;

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

-- The re-seal of one decided or live document, in one statement that the guard recognises. The caller (the worker) has already opened the
-- old value, sealed it again with the current key and checked that the new value opens to the same text; here the swap is compare-and-swap
-- (the old bytes are in the WHERE), so a row that changed meanwhile is left alone and the call says so. The organization must be one of the
-- context of the caller. The setting that opens the door of the guard lives only inside this function: it is set, the statement runs, and it
-- is put back before the function returns.
CREATE FUNCTION fiscal_reseal_document(
  p_organization_id text, p_id text, p_old_receiver bytea, p_new_receiver bytea, p_old_payload bytea, p_new_payload bytea
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    changed integer;
  BEGIN
    IF p_organization_id IS NULL OR NOT (p_organization_id = ANY (public.app_organization_ids())) THEN
      RAISE EXCEPTION 'the organization is not in the context of the caller' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_old_receiver IS NULL OR NOT public.fiscal_reseal_shape_ok(p_new_receiver) THEN
      RAISE EXCEPTION 'a re-seal needs a sealed receiver' USING ERRCODE = 'check_violation';
    END IF;
    -- The payload is sealed again or stays absent: never erased, never invented
    IF (p_old_payload IS NULL) IS DISTINCT FROM (p_new_payload IS NULL)
       OR (p_new_payload IS NOT NULL AND NOT public.fiscal_reseal_shape_ok(p_new_payload)) THEN
      RAISE EXCEPTION 'a re-seal keeps the payload it had' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM pg_catalog.set_config('app.fiscal_reseal', 'on', true);
    UPDATE public.fiscal_documents
       SET receiver_encrypted = p_new_receiver, built_payload_encrypted = p_new_payload
     WHERE id = p_id AND organization_id = p_organization_id
       AND receiver_encrypted = p_old_receiver
       AND built_payload_encrypted IS NOT DISTINCT FROM p_old_payload;
    GET DIAGNOSTICS changed = ROW_COUNT;
    PERFORM pg_catalog.set_config('app.fiscal_reseal', 'off', true);
    RETURN changed = 1;
  END
  $$;
REVOKE EXECUTE ON FUNCTION fiscal_reseal_document(text, text, bytea, bytea, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fiscal_reseal_document(text, text, bytea, bytea, bytea, bytea) TO platform_worker;

CREATE OR REPLACE FUNCTION fiscal_contingency_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a fiscal contingency is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- The re-seal of the responsible (Step 7.3-S11b-1): through the door, a contingency, whatever its status, changes only that column
  IF fiscal_reseal_door_open() THEN
    IF (to_jsonb(NEW) - 'responsible_encrypted' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'responsible_encrypted' - 'updated_at') THEN
      RAISE EXCEPTION 'a re-seal changes only the sealed column' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
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

-- The same for the responsible of a contingency (a reported one never changes otherwise)
CREATE FUNCTION fiscal_reseal_contingency(p_organization_id text, p_id text, p_old bytea, p_new bytea) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    changed integer;
  BEGIN
    IF p_organization_id IS NULL OR NOT (p_organization_id = ANY (public.app_organization_ids())) THEN
      RAISE EXCEPTION 'the organization is not in the context of the caller' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_old IS NULL OR NOT public.fiscal_reseal_shape_ok(p_new) THEN
      RAISE EXCEPTION 'a re-seal needs a sealed value' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM pg_catalog.set_config('app.fiscal_reseal', 'on', true);
    UPDATE public.fiscal_contingencies SET responsible_encrypted = p_new
     WHERE id = p_id AND organization_id = p_organization_id AND responsible_encrypted = p_old;
    GET DIAGNOSTICS changed = ROW_COUNT;
    PERFORM pg_catalog.set_config('app.fiscal_reseal', 'off', true);
    RETURN changed = 1;
  END
  $$;
REVOKE EXECUTE ON FUNCTION fiscal_reseal_contingency(text, text, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fiscal_reseal_contingency(text, text, bytea, bytea) TO platform_worker;
