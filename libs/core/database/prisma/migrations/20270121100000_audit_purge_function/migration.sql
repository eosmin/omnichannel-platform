-- The audit log is append-only for every role of the application, the worker included (TDD_05 §9.3, owner decision
-- 2026-11-18, finding OPS-R2-F02). Until now platform_worker kept DELETE so that the cold export of a month could remove the
-- rows it had copied: a job of the worker, or anything that ran as that role, could erase any entry. Retention no longer
-- deletes with the role of the application. It calls purge_audit_logs(), a SECURITY DEFINER function owned by the role that
-- runs migrations (the owner of the table), with a fixed search_path, which:
--   * deletes only the ids it is given that are older than the hot window. The window is the caller's (the constant
--     DataRetentionPolicies.AUDIT_LOGS_HOT of libs/core, not configurable per store or organization) and the function holds a
--     floor of 730 days under it: a caller that passes less is refused, so a recent entry is out of reach whatever it passes;
--   * asks for the evidence of the cold export (object key, SHA-256 of the object and its number of rows) and writes it, with
--     what was purged, when and by which rule, as an audit entry of its own, in the same transaction as the delete;
--   * is idempotent (an id that is already gone deletes nothing and writes no entry) and takes its own advisory lock, so two
--     purges never interleave their entries.
-- The database cannot read the bucket: that the copy was verified stays the duty of the exporter, which holds the lock of
-- the month. What the function guarantees is the window, the evidence on record and the trace, and that the trace is written
-- by the function itself, so the worker cannot delete without leaving it. A worker that is fully compromised could still pass
-- invented evidence for entries past the window: the entry would then record that evidence, but nothing here proves it true.
-- Deploy order: apply this migration before the worker release that calls the function. A worker of the previous release
-- that runs the cold export in between gets "permission denied" on its DELETE; the month stays in the table and the next run
-- (the job is monthly and idempotent) exports and purges it.
REVOKE DELETE, UPDATE, TRUNCATE ON TABLE audit_logs FROM platform_worker;

CREATE FUNCTION purge_audit_logs(
  p_ids text[],
  p_export_key text,
  p_export_sha256 text,
  p_export_rows integer,
  p_hot_days integer
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_window_end timestamp;
  v_deleted integer;
  v_oldest timestamp;
  v_newest timestamp;
BEGIN
  IF p_hot_days IS NULL OR p_hot_days < 730 THEN
    RAISE EXCEPTION 'AUDIT_PURGE_INPUT: the hot window is at least 730 days';
  END IF;
  v_window_end := (now() AT TIME ZONE 'UTC') - make_interval(days => p_hot_days);
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RAISE EXCEPTION 'AUDIT_PURGE_INPUT: no ids to purge';
  END IF;
  IF cardinality(p_ids) > 5000 THEN
    RAISE EXCEPTION 'AUDIT_PURGE_INPUT: at most 5000 ids a call';
  END IF;
  IF p_export_key IS NULL OR length(p_export_key) = 0 OR length(p_export_key) > 512 THEN
    RAISE EXCEPTION 'AUDIT_PURGE_INPUT: the key of the cold export is required';
  END IF;
  IF p_export_sha256 IS NULL OR p_export_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'AUDIT_PURGE_INPUT: the SHA-256 of the cold export is required';
  END IF;
  IF p_export_rows IS NULL OR p_export_rows < cardinality(p_ids) THEN
    RAISE EXCEPTION 'AUDIT_PURGE_INPUT: the cold export holds fewer rows than the ids to purge';
  END IF;

  -- A purge waits at most a few seconds for another one: it fails and the exporter retries on its next run
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM pg_advisory_xact_lock(hashtextextended('audit-purge', 0));

  WITH gone AS (
    DELETE FROM public.audit_logs WHERE id = ANY(p_ids) AND "timestamp" < v_window_end RETURNING "timestamp"
  )
  SELECT count(*), min("timestamp"), max("timestamp") INTO v_deleted, v_oldest, v_newest FROM gone;

  IF v_deleted > 0 THEN
    INSERT INTO public.audit_logs (id, action, resource_type, metadata, "timestamp")
    VALUES (
      gen_random_uuid()::text,
      'audit_log.purged',
      'audit_log',
      jsonb_build_object(
        'rule', 'audit-cold-export',
        'windowDays', p_hot_days,
        'requested', cardinality(p_ids),
        'deleted', v_deleted,
        'oldest', v_oldest,
        'newest', v_newest,
        'exportKey', p_export_key,
        'exportSha256', p_export_sha256,
        'exportRows', p_export_rows
      ),
      now() AT TIME ZONE 'UTC'
    );
  END IF;
  RETURN v_deleted;
END $$;

REVOKE ALL ON FUNCTION purge_audit_logs(text[], text, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_audit_logs(text[], text, text, integer, integer) TO platform_worker;

-- Nobody changes an entry: not the application (the privileges), and not the owner of the table (this trigger), who could
-- UPDATE until now. The one exception is the action of the foreign key to users, ON DELETE SET NULL, which clears user_id of
-- an entry whose user is already gone and touches nothing else: a direct UPDATE that clears the user_id of a person who
-- still exists is refused. The owner can still DELETE (the test suites clean up after themselves as the owner); that is a
-- credential of migrations and operators, never of the application.
CREATE FUNCTION forbid_audit_log_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.user_id IS NOT NULL AND NEW.user_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = OLD.user_id)
     AND (to_jsonb(NEW) - 'user_id') = (to_jsonb(OLD) - 'user_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'AUDIT_LOG_IMMUTABLE: % of % is not allowed, the audit log is append-only', TG_OP, TG_TABLE_NAME;
END $$;

CREATE TRIGGER trg_audit_logs_no_update BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_log_change();
CREATE TRIGGER trg_audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_log_change();
