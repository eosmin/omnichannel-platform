-- rls_store_tables_with_rows(p_store_id) ran as the owner of the tables and trusted its parameter: any session of platform_app could ask
-- which tables hold rows of ANY store, and how many (audit of the SECURITY DEFINER functions, area 5). It now checks the store against the
-- context, read once into variables: the store must be one of app_store_ids() or belong to one of app_organization_ids() (the delete of a
-- store runs with the organization of the request in its context). No context, a store of another organization, and a store that does not
-- exist raise the same 22023, so the function does not tell which ids are real. The rest of the body (the owner's view of every row, the
-- fail-closed checks, the fixed list of skipped tables) is the one of 20270121300000_rls_phase3_orders_inventory_shipping, unchanged.
-- search_path ends in pg_temp (validate:definer); EXECUTE stays with platform_app alone. A migration of a function, no table: nothing for
-- rls_extend_policies_to_replica() to extend.
-- Trust: the context is two session settings, the same one every policy trusts. This check stops a missing or wrong context (a code path
-- that forgot it, a request for another organization); it is not a barrier against a session that can run arbitrary SQL and set the
-- settings itself (that is the debt of the context in general). Deploy order: the API that opens the context first, then this migration.
-- Rollback: rollbacks/20270123200000_rls_store_tables_with_rows_context.rollback.sql (the code that opens the context goes first).

CREATE OR REPLACE FUNCTION public.rls_store_tables_with_rows(p_store_id text)
  RETURNS TABLE (table_name text, row_count integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    rel record;
    sees_all boolean;
    found_any boolean := false;
    -- Tables whose rows go with the store and are not data of the business. Fixed here, never given by the caller: a list that came
    -- from outside could hide every table and let the delete of a store go through with its data
    skipped text[] := ARRAY['store_settings', 'retention_settings', 'business_hours', 'memberships', 'invitations', 'roles', 'audit_logs'];
    n integer;
    -- The context is read ONCE, into variables: the function runs as the owner, so the store of the parameter is checked against it
    v_stores text[] := public.app_store_ids();
    v_orgs text[] := public.app_organization_ids();
  BEGIN
    IF p_store_id IS NULL OR p_store_id = '' THEN
      RAISE EXCEPTION 'rls_store_tables_with_rows: a store id is required' USING ERRCODE = '22023';
    END IF;
    -- A store that is not in the context (no context at all, a store or an organization of someone else) and a store that does not
    -- exist are the same error, so the function says nothing about which ids are real
    IF NOT (
      p_store_id = ANY (v_stores)
      OR EXISTS (SELECT 1 FROM public.stores s WHERE s.id = p_store_id AND s.organization_id = ANY (v_orgs))
    ) THEN
      RAISE EXCEPTION 'rls_store_tables_with_rows: the store is not in the context' USING ERRCODE = '22023';
    END IF;
    SELECT r.rolsuper OR r.rolbypassrls INTO sees_all FROM pg_catalog.pg_roles r WHERE r.rolname = current_user;
    FOR rel IN
      SELECT c.oid, c.relname::text AS relname, c.relowner
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attname = 'store_id' AND NOT a.attisdropped AND a.attnum > 0
      WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND c.relname::text <> ALL (skipped)
      ORDER BY c.relname
    LOOP
      -- Closed: a table this role does not own and cannot bypass may hide rows from the count
      IF NOT coalesce(sees_all, false) AND rel.relowner <> (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
        RAISE EXCEPTION 'rls_store_tables_with_rows: cannot see every row of %', rel.relname;
      END IF;
      -- A table with row security on must have, for this role, a permissive policy that shows every row and no restrictive one:
      -- the count of a table whose policies hide rows from its own owner would be a wrong zero
      IF NOT coalesce(sees_all, false)
         AND (SELECT c2.relrowsecurity FROM pg_catalog.pg_class c2 WHERE c2.oid = rel.oid)
         AND (
           NOT EXISTS (
             SELECT 1 FROM pg_catalog.pg_policy p
             WHERE p.polrelid = rel.oid AND p.polpermissive AND p.polcmd IN ('*', 'r')
               AND (p.polroles = ARRAY[0::oid] OR (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) = ANY (p.polroles))
               AND pg_catalog.pg_get_expr(p.polqual, p.polrelid) = 'true')
           OR EXISTS (
             SELECT 1 FROM pg_catalog.pg_policy p
             WHERE p.polrelid = rel.oid AND NOT p.polpermissive
               AND (p.polroles = ARRAY[0::oid] OR (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) = ANY (p.polroles)))
         ) THEN
        RAISE EXCEPTION 'rls_store_tables_with_rows: row security of % may hide rows from this role', rel.relname;
      END IF;
      found_any := true;
      EXECUTE format('SELECT count(*)::integer FROM public.%I WHERE store_id = $1', rel.relname) INTO n USING p_store_id;
      IF n > 0 THEN
        table_name := rel.relname;
        row_count := n;
        RETURN NEXT;
      END IF;
    END LOOP;
    IF NOT found_any THEN
      RAISE EXCEPTION 'rls_store_tables_with_rows: no table with a store_id was found';
    END IF;
  END
  $$;

REVOKE ALL ON FUNCTION public.rls_store_tables_with_rows(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rls_store_tables_with_rows(text) TO platform_app;
