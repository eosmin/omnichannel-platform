-- What a person said about their data is a record of fact, and it is append-only (TDD_05 §10, Step 7.2-K2, debt (e) of Step 7.2-D): a
-- change of mind is a NEW row and the newest row of a purpose rules, so no statement of the application, of a plugin or of anyone else
-- may rewrite what was said or when. Until now only the code kept that promise. The database now refuses, to every role (the owner of the
-- table too):
--   * TRUNCATE of consent_records;
--   * DELETE of a row, unless it is the cascade of a foreign key (pg_trigger_depth() > 1): the customer it belongs to, or its store,
--     was deleted. That is the only way a row leaves: a customer with no conversations or orders is deleted by its owner
--     (`DELETE /customers/:id`), and a store takes its customers with it. A statement that deletes consent_records itself is refused;
--   * an UPDATE that changes anything but the four columns the platform has a reason to change, each one only in its own direction:
--       - customer_id: the merge of two customers moves what the absorbed one said to the survivor, and the undo moves it back;
--       - revoked_at: set once, from NULL to an instant (the erasure of the customer revokes what was granted); never moved, never cleared;
--       - ip_address and user_agent: only cleared to NULL (the erasure takes the address and the browser of the person out of the row).
--     Not allowed, whatever the role: purpose, legal_basis, granted, granted_at, source, store_id, id and created_at.
-- The policy of the table (rls_apply_policy('consent_records', 'store'), migration 20270121110000) and the grants are not touched.
-- Deploy: nothing in the application writes a row the trigger refuses (checked by tests/security/consent-records-append-only.spec.ts and
-- by the customer erasure and merge suites), so it can be applied before or after the release.
CREATE FUNCTION forbid_consent_record_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'CONSENT_RECORD_IMMUTABLE: TRUNCATE of % is not allowed, what a person said is append-only', TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- The cascade of the foreign key of the customer or of the store runs as a trigger of its own, so this one sees a depth above 1
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'CONSENT_RECORD_IMMUTABLE: DELETE of % is not allowed, a row leaves only with its customer or its store', TG_TABLE_NAME;
  END IF;
  IF (to_jsonb(NEW) - 'customer_id' - 'revoked_at' - 'ip_address' - 'user_agent')
     IS DISTINCT FROM (to_jsonb(OLD) - 'customer_id' - 'revoked_at' - 'ip_address' - 'user_agent') THEN
    RAISE EXCEPTION 'CONSENT_RECORD_IMMUTABLE: only customer_id, revoked_at, ip_address and user_agent of % may change', TG_TABLE_NAME;
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'CONSENT_RECORD_IMMUTABLE: revoked_at of % is set once and is not moved or cleared', TG_TABLE_NAME;
  END IF;
  IF (NEW.ip_address IS NOT NULL AND NEW.ip_address IS DISTINCT FROM OLD.ip_address)
     OR (NEW.user_agent IS NOT NULL AND NEW.user_agent IS DISTINCT FROM OLD.user_agent) THEN
    RAISE EXCEPTION 'CONSENT_RECORD_IMMUTABLE: ip_address and user_agent of % are only cleared, never written again', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_consent_records_append_only BEFORE UPDATE OR DELETE ON consent_records
  FOR EACH ROW EXECUTE FUNCTION forbid_consent_record_change();
CREATE TRIGGER trg_consent_records_no_truncate BEFORE TRUNCATE ON consent_records
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_consent_record_change();
