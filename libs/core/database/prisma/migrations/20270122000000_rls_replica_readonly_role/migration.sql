-- platform_replica_ro: the role of DATABASE_REPLICA_URL (PrismaService.replicaTenantRead). It can only READ: SELECT is the only
-- privilege it holds, so a write through a connection of this role fails (42501, or 25006 while the session default below is on), on a
-- real standby AND where DATABASE_REPLICA_URL points at this role on the same server (development, CI), instead of depending on
-- `SET TRANSACTION READ ONLY`, which did not hold in CI (the callback saw 'off'). Without DATABASE_REPLICA_URL the replica handle
-- is the primary client (platform_app): setting the variable is what turns the guarantee on (Step 7.1, activation runbook).
--
-- Row-Level Security: the policies of the tenant tables name their roles (TO platform_app, platform_worker), so a role that is not
-- in the list sees no rows once enforcement is on. rls_extend_policies_to_replica() adds this role to every EXISTING policy that
-- names platform_app and that can read (SELECT or ALL), once; rls_apply_policy (redefined below) names it in the policies it makes
-- from now on. The role has no write privilege, so INSERT/UPDATE/DELETE policies need nothing. tests/security/rls-replica-role.spec.ts
-- fails when a policy or a table privilege drifted.
--
-- The role is created NOLOGIN: scripts/set-db-role-passwords.ts gives it LOGIN and a password (DB_REPLICA_PASSWORD) where a replica
-- is used. Rollback: rollbacks/20270122000000_rls_replica_readonly_role.rollback.sql.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_replica_ro') THEN
    CREATE ROLE platform_replica_ro NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- A second line of defence, not the guarantee: a session of this role starts read only
ALTER ROLE platform_replica_ro SET default_transaction_read_only = on;

GRANT USAGE ON SCHEMA public TO platform_replica_ro;
GRANT EXECUTE ON FUNCTION app_store_ids(), app_organization_ids(), app_user_id() TO platform_replica_ro;

-- SELECT where platform_app has SELECT, and nowhere else: a table the api cannot read (a secret kept apart) stays unreadable here
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT DISTINCT table_name FROM information_schema.table_privileges
     WHERE grantee = 'platform_app' AND table_schema = 'public' AND privilege_type = 'SELECT'
  LOOP
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO platform_replica_ro', t.table_name);
  END LOOP;
END
$$;
-- No default privilege on purpose: a table made later, which the api may not read, must not be readable here. A new table with a
-- policy gets its SELECT from rls_apply_policy (below); a table with no policy (a global one) needs its own GRANT, and
-- tests/security/rls-replica-role.spec.ts fails until it has it.

-- rls_apply_policy again, with the replica in the policies it creates and its SELECT grant: a call for a new table, or a call that
-- re-applies the policy of an old one, no longer drops the role from it. Same body as 20270119100000_rls_foundation otherwise.
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
      EXECUTE format('CREATE POLICY %I ON %s AS PERMISSIVE FOR SELECT TO platform_app, platform_worker, platform_replica_ro USING (%s)',
        table_name || '_tenant', tbl, relaxed_pred);
      EXECUTE format('CREATE POLICY %I ON %s AS PERMISSIVE FOR INSERT TO platform_app, platform_worker WITH CHECK (%s)',
        table_name || '_tenant_ins', tbl, strict_pred);
      EXECUTE format('CREATE POLICY %I ON %s AS PERMISSIVE FOR UPDATE TO platform_app, platform_worker USING (%s) WITH CHECK (%s)',
        table_name || '_tenant_upd', tbl, strict_pred, strict_pred);
      EXECUTE format('CREATE POLICY %I ON %s AS PERMISSIVE FOR DELETE TO platform_app, platform_worker USING (%s)',
        table_name || '_tenant_del', tbl, strict_pred);
    ELSE
      EXECUTE format('CREATE POLICY %I ON %s AS PERMISSIVE FOR ALL TO platform_app, platform_worker, platform_replica_ro USING (%s) WITH CHECK (%s)',
        table_name || '_tenant', tbl, strict_pred, strict_pred);
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', table_name || '_owner', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %s AS PERMISSIVE FOR ALL TO %I USING (true) WITH CHECK (true)',
      table_name || '_owner', tbl, owner_role
    );
    -- The replica reads what the api reads: SELECT on this table when platform_app has it (a table the api cannot read stays closed)
    IF has_table_privilege('platform_app', tbl, 'SELECT') THEN
      EXECUTE format('GRANT SELECT ON TABLE %s TO platform_replica_ro', tbl);
    END IF;
  END
  $$;

CREATE FUNCTION rls_extend_policies_to_replica() RETURNS integer
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  p record;
  changed integer := 0;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, roles FROM pg_policies
     WHERE schemaname = 'public'
       AND cmd IN ('SELECT', 'ALL')
       AND 'platform_app'::name = ANY (roles)
       AND NOT ('platform_replica_ro'::name = ANY (roles))
  LOOP
    EXECUTE format(
      'ALTER POLICY %I ON %I.%I TO %s',
      p.policyname, p.schemaname, p.tablename,
      (SELECT string_agg(quote_ident(r), ', ') FROM unnest(p.roles || 'platform_replica_ro'::name) AS r)
    );
    changed := changed + 1;
  END LOOP;
  RETURN changed;
END
$$;
REVOKE ALL ON FUNCTION rls_extend_policies_to_replica() FROM PUBLIC;

SELECT rls_extend_policies_to_replica();
