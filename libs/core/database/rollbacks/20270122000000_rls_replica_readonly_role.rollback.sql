-- Rollback of 20270122000000_rls_replica_readonly_role: the code that connects with DATABASE_REPLICA_URL as platform_replica_ro
-- goes first (point it at another role or unset it), then this runs. Idempotent.
DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, roles FROM pg_policies
     WHERE schemaname = 'public' AND 'platform_replica_ro'::name = ANY (roles)
  LOOP
    EXECUTE format(
      'ALTER POLICY %I ON %I.%I TO %s',
      p.policyname, p.schemaname, p.tablename,
      (SELECT string_agg(quote_ident(r), ', ') FROM unnest(array_remove(p.roles, 'platform_replica_ro'::name)) AS r)
    );
  END LOOP;
END
$$;
DROP FUNCTION IF EXISTS rls_extend_policies_to_replica();
-- rls_apply_policy goes back to the body of 20270119100000_rls_foundation (no replica role, no grant to it)
CREATE OR REPLACE FUNCTION rls_apply_policy(tbl regclass, scope text) RETURNS void
  LANGUAGE plpgsql
  AS $$
  DECLARE
    strict_pred text;
    relaxed_pred text;
    table_name text;
    owner_role name;
    split boolean := scope IN ('store_or_null', 'organization_or_null');
  BEGIN
    strict_pred := CASE scope
      WHEN 'store' THEN 'store_id = ANY ((SELECT app_store_ids())::text[])'
      WHEN 'store_or_null' THEN 'store_id = ANY ((SELECT app_store_ids())::text[])'
      WHEN 'organization' THEN 'organization_id = ANY ((SELECT app_organization_ids())::text[])'
      WHEN 'organization_or_null' THEN 'organization_id = ANY ((SELECT app_organization_ids())::text[])'
      WHEN 'store_or_organization' THEN
        '(store_id = ANY ((SELECT app_store_ids())::text[]) OR organization_id = ANY ((SELECT app_organization_ids())::text[]))'
    END;
    IF strict_pred IS NULL THEN
      RAISE EXCEPTION 'rls_apply_policy: unknown scope %, expected store, organization, store_or_null, organization_or_null or store_or_organization', scope;
    END IF;
    relaxed_pred := CASE scope
      WHEN 'store_or_null' THEN 'store_id IS NULL OR ' || strict_pred
      WHEN 'organization_or_null' THEN 'organization_id IS NULL OR ' || strict_pred
      ELSE strict_pred
    END;
    SELECT c.relname, pg_get_userbyid(c.relowner) INTO table_name, owner_role FROM pg_class c WHERE c.oid = tbl;
    -- Postgres cuts an identifier at 63 bytes: a name that long would get a policy that the switch and the view cannot find
    IF octet_length(table_name || '_tenant_ins') > 63 THEN
      RAISE EXCEPTION 'rls_apply_policy: the name of table % is too long for its policy names (63 bytes)', table_name;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', table_name || '_tenant', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', table_name || '_tenant_ins', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', table_name || '_tenant_upd', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', table_name || '_tenant_del', tbl);
    IF split THEN
      EXECUTE format('CREATE POLICY %I ON %s AS PERMISSIVE FOR SELECT TO platform_app, platform_worker USING (%s)',
        table_name || '_tenant', tbl, relaxed_pred);
      EXECUTE format('CREATE POLICY %I ON %s AS PERMISSIVE FOR INSERT TO platform_app, platform_worker WITH CHECK (%s)',
        table_name || '_tenant_ins', tbl, strict_pred);
      EXECUTE format('CREATE POLICY %I ON %s AS PERMISSIVE FOR UPDATE TO platform_app, platform_worker USING (%s) WITH CHECK (%s)',
        table_name || '_tenant_upd', tbl, strict_pred, strict_pred);
      EXECUTE format('CREATE POLICY %I ON %s AS PERMISSIVE FOR DELETE TO platform_app, platform_worker USING (%s)',
        table_name || '_tenant_del', tbl, strict_pred);
    ELSE
      EXECUTE format('CREATE POLICY %I ON %s AS PERMISSIVE FOR ALL TO platform_app, platform_worker USING (%s) WITH CHECK (%s)',
        table_name || '_tenant', tbl, strict_pred, strict_pred);
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', table_name || '_owner', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %s AS PERMISSIVE FOR ALL TO %I USING (true) WITH CHECK (true)',
      table_name || '_owner', tbl, owner_role
    );
  END
  $$;
-- The role itself stays (a role belongs to the server, not to a database: another database of the cluster may still grant it
-- something, and DROP ROLE would refuse): it loses its login and every privilege of this database.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_replica_ro') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM platform_replica_ro;
    REVOKE ALL ON SCHEMA public FROM platform_replica_ro;
    IF to_regprocedure('app_store_ids()') IS NOT NULL AND to_regprocedure('app_user_id()') IS NOT NULL THEN
      REVOKE ALL ON FUNCTION app_store_ids(), app_organization_ids(), app_user_id() FROM platform_replica_ro;
    END IF;
    ALTER ROLE platform_replica_ro RESET default_transaction_read_only;
    ALTER ROLE platform_replica_ro NOLOGIN PASSWORD NULL;
  END IF;
END
$$;
