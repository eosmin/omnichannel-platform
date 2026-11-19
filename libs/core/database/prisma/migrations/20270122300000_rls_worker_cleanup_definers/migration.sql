-- Row-Level Security, phase 5 (worker), PR B2: what the cleaners of the worker read or write across every owner once the role loses
-- BYPASSRLS. Two groups, both SECURITY DEFINER with a fixed search_path (pg_temp last), qualified objects, granted to platform_worker
-- alone, and refusing a page outside 1..1000 (rls_check_page_limit, never a clamp):
--   1. the audit log: the cold export reads a month of every store and organization (the policy of audit_logs answers a context, never
--      the whole table). The page is ordered by (timestamp, id), the order and the window of purge_audit_logs, so the bytes that are
--      hashed are the rows that the purge deletes. Nothing is written here: the only delete stays purge_audit_logs.
--   2. the avatar: the one media with no store (purpose avatar, uploaded_by = the person). No store context can read it, and a sweep
--      has no person. The list returns ids and keys; the one write decides and deletes in a single statement and only for that id.

CREATE FUNCTION rls_audit_oldest_before(p_before timestamp) RETURNS timestamp
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_oldest timestamp;
  BEGIN
    IF p_before IS NULL THEN
      RAISE EXCEPTION 'the limit of the audit read is required' USING ERRCODE = '22023';
    END IF;
    SELECT min(a."timestamp") INTO v_oldest FROM public.audit_logs a WHERE a."timestamp" < p_before;
    RETURN v_oldest;
  END
  $$;

CREATE FUNCTION rls_audit_count_between(p_start timestamp, p_end timestamp) RETURNS bigint
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_count bigint;
  BEGIN
    IF p_start IS NULL OR p_end IS NULL THEN
      RAISE EXCEPTION 'the window of the audit read is required' USING ERRCODE = '22023';
    END IF;
    SELECT count(*) INTO v_count FROM public.audit_logs a WHERE a."timestamp" >= p_start AND a."timestamp" < p_end;
    RETURN v_count;
  END
  $$;

-- A page of a month: the rows after (p_after_ts, p_after_id), by (timestamp, id). The first page passes NULL in both.
CREATE FUNCTION rls_audit_logs_for_cold_export(
  p_start timestamp, p_end timestamp, p_after_ts timestamp, p_after_id text, p_limit integer
) RETURNS SETOF public.audit_logs
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    PERFORM public.rls_check_page_limit(p_limit);
    IF p_start IS NULL OR p_end IS NULL THEN
      RAISE EXCEPTION 'the window of the audit read is required' USING ERRCODE = '22023';
    END IF;
    IF (p_after_ts IS NULL) <> (p_after_id IS NULL) THEN
      RAISE EXCEPTION 'the cursor of the audit read is a pair' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY
      SELECT a.* FROM public.audit_logs a
      WHERE a."timestamp" >= p_start AND a."timestamp" < p_end
        AND (p_after_ts IS NULL OR a."timestamp" > p_after_ts OR (a."timestamp" = p_after_ts AND a.id > p_after_id))
      ORDER BY a."timestamp", a.id LIMIT p_limit;
  END
  $$;

-- Avatar media (no store), filtered by what the caller asks: states, creation before, scan after, the people. NULL filter = no filter.
CREATE FUNCTION rls_list_avatar_media(
  p_statuses text[], p_created_before timestamp, p_scanned_after timestamp, p_user_ids text[], p_after text, p_limit integer
) RETURNS TABLE (id text, key text, status text, created_at timestamp, uploaded_by text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    PERFORM public.rls_check_page_limit(p_limit);
    RETURN QUERY
      SELECT m.id, m.key, m.status, m.created_at, m.uploaded_by FROM public.media m
      WHERE m.store_id IS NULL AND m.purpose = 'avatar'
        AND (p_statuses IS NULL OR m.status = ANY (p_statuses))
        AND (p_created_before IS NULL OR m.created_at < p_created_before)
        AND (p_scanned_after IS NULL OR m.scanned_at > p_scanned_after)
        AND (p_user_ids IS NULL OR m.uploaded_by = ANY (p_user_ids))
        AND (p_after IS NULL OR m.id > p_after)
      ORDER BY m.id LIMIT p_limit;
  END
  $$;

-- The avatar rows that no person points at (or whose scan refused them), older than the cutoff: the candidates of the sweep
CREATE FUNCTION rls_list_orphan_avatars(
  p_cutoff timestamp, p_refused_statuses text[], p_user_ids text[], p_after text, p_limit integer
) RETURNS TABLE (id text, key text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    PERFORM public.rls_check_page_limit(p_limit);
    IF p_cutoff IS NULL OR p_refused_statuses IS NULL THEN
      RAISE EXCEPTION 'the cutoff and the refused states are required' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY
      SELECT m.id, m.key FROM public.media m
      WHERE m.store_id IS NULL AND m.purpose = 'avatar' AND m.created_at < p_cutoff
        AND (p_user_ids IS NULL OR m.uploaded_by = ANY (p_user_ids))
        AND (m.status = ANY (p_refused_statuses)
             OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.avatar_media_id = m.id))
        AND (p_after IS NULL OR m.id > p_after)
      ORDER BY m.id LIMIT p_limit;
  END
  $$;

-- The one write: one avatar row, by id, only if it is still an avatar with no store older than the cutoff. A person who attached a
-- refused picture while it was pending has the pointer cleared (the picture is no picture); the row is deleted only if nobody points at
-- it. The refused states are fixed inside. A row that another run holds is skipped (SKIP LOCKED). Returns the key of the object to delete, or NULL when nothing was removed.
CREATE FUNCTION rls_clear_orphan_avatar(p_media_id text, p_cutoff timestamp) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_status text;
    v_key text;
  BEGIN
    IF p_media_id IS NULL OR p_cutoff IS NULL THEN
      RAISE EXCEPTION 'the avatar and the cutoff are required' USING ERRCODE = '22023';
    END IF;
    -- A write that removes a person's picture is never for a row younger than an hour: a cutoff in the future would reach every avatar
    IF p_cutoff > (pg_catalog.now() AT TIME ZONE 'UTC') - interval '1 hour' THEN
      RAISE EXCEPTION 'the cutoff of an avatar sweep is at least an hour old' USING ERRCODE = '22023';
    END IF;
    SELECT m.status, m.key INTO v_status, v_key FROM public.media m
      WHERE m.id = p_media_id AND m.store_id IS NULL AND m.purpose = 'avatar' AND m.created_at < p_cutoff
      FOR UPDATE OF m SKIP LOCKED;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    -- The refused states are the function's own (MediaStatus.INFECTED and UNSCANNABLE; a spec compares them with the enum): a caller
    -- cannot widen them to detach the picture of a person whose scan passed
    IF v_status IN ('infected', 'unscannable') THEN
      UPDATE public.users SET avatar_media_id = NULL WHERE avatar_media_id = p_media_id;
    END IF;
    IF EXISTS (SELECT 1 FROM public.users u WHERE u.avatar_media_id = p_media_id) THEN
      RETURN NULL;
    END IF;
    DELETE FROM public.media WHERE id = p_media_id;
    RETURN v_key;
  END
  $$;

-- The keys of the avatar rows of some ids (the sweep of stray avatar files asks which final keys a row still names)
CREATE FUNCTION rls_avatar_media_keys(p_ids text[]) RETURNS TABLE (id text, key text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF p_ids IS NULL OR cardinality(p_ids) > 1000 THEN
      RAISE EXCEPTION 'at most 1000 ids a call' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT m.id, m.key FROM public.media m
      WHERE m.id = ANY (p_ids) AND m.store_id IS NULL AND m.purpose = 'avatar';
  END
  $$;

REVOKE ALL ON FUNCTION public.rls_audit_oldest_before(timestamp) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rls_audit_count_between(timestamp, timestamp) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rls_audit_logs_for_cold_export(timestamp, timestamp, timestamp, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rls_list_avatar_media(text[], timestamp, timestamp, text[], text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rls_list_orphan_avatars(timestamp, text[], text[], text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rls_clear_orphan_avatar(text, timestamp) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rls_avatar_media_keys(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rls_audit_oldest_before(timestamp) TO platform_worker;
GRANT EXECUTE ON FUNCTION public.rls_audit_count_between(timestamp, timestamp) TO platform_worker;
GRANT EXECUTE ON FUNCTION public.rls_audit_logs_for_cold_export(timestamp, timestamp, timestamp, text, integer) TO platform_worker;
GRANT EXECUTE ON FUNCTION public.rls_list_avatar_media(text[], timestamp, timestamp, text[], text, integer) TO platform_worker;
GRANT EXECUTE ON FUNCTION public.rls_list_orphan_avatars(timestamp, text[], text[], text, integer) TO platform_worker;
GRANT EXECUTE ON FUNCTION public.rls_clear_orphan_avatar(text, timestamp) TO platform_worker;
GRANT EXECUTE ON FUNCTION public.rls_avatar_media_keys(text[]) TO platform_worker;
