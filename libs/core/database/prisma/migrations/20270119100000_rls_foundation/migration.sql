-- Row-Level Security, foundation (TDD_01 section 3.2, layer 3). This migration creates the tools and no policy: a table gets its
-- policy in the migration of its group (rls_apply_policy), and no policy binds anybody until the owner turns enforcement on
-- (rls_set_enforcement). Nothing changes for the application by running this file.
--
-- The context is two transaction-local settings, set by PrismaService.tenantTransaction with set_config(..., true):
--   app.store_ids          the stores of the caller, comma separated (one for an ordinary request)
--   app.organization_ids   the organizations of the caller, comma separated
-- A transaction that sets nothing has an empty context, so it sees no rows and writes none: the policies fail closed.
-- The id columns of this schema are TEXT (uuid strings), so the functions answer text[].

CREATE FUNCTION app_store_ids() RETURNS text[]
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$
    SELECT CASE
      WHEN nullif(current_setting('app.store_ids', true), '') IS NULL THEN ARRAY[]::text[]
      ELSE string_to_array(current_setting('app.store_ids', true), ',')
    END
  $$;

CREATE FUNCTION app_organization_ids() RETURNS text[]
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$
    SELECT CASE
      WHEN nullif(current_setting('app.organization_ids', true), '') IS NULL THEN ARRAY[]::text[]
      ELSE string_to_array(current_setting('app.organization_ids', true), ',')
    END
  $$;

-- The standard policy of a table, in one place so that every table has the same predicate.
--   <table>_tenant  for platform_app and platform_worker, USING and WITH CHECK alike (FOR ALL): a row is visible and writable only
--                   when its store_id (scope 'store') or organization_id (scope 'organization') is in the context. The predicate
--                   calls the function inside a sub-select so that Postgres evaluates it once per statement (an InitPlan) and
--                   can still use the index that starts with the column.
--   <table>_owner   for the role that owns the table (the one of the migrations, DIRECT_DATABASE_URL): the only role that
--                   skips the tenant check. It is explicit because FORCE ROW LEVEL SECURITY would otherwise bind the owner too
--                   and leave it with no rows.
-- The scopes store_or_null and organization_or_null are for rows that may have no owner (an avatar upload, an official plugin):
-- the row is READ by every context but INSERTED, UPDATED and DELETED only with an owner in the context. A DELETE is checked
-- against USING alone, so the relaxed predicate may only be on the SELECT policy: the four commands are separate policies
-- (<table>_tenant for SELECT, <table>_tenant_ins, <table>_tenant_upd, <table>_tenant_del). store_or_organization shows and
-- writes a row through its store or its organization.
-- Safe to run twice. It does not turn row security on.
CREATE FUNCTION rls_apply_policy(tbl regclass, scope text) RETURNS void
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

-- The inverse, for the rollback of a group of tables. Turns row security off on the table too.
CREATE FUNCTION rls_drop_policy(tbl regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
  DECLARE
    table_name text;
  BEGIN
    SELECT c.relname INTO table_name FROM pg_class c WHERE c.oid = tbl;
    EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %s DISABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', table_name || '_tenant', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', table_name || '_tenant_ins', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', table_name || '_tenant_upd', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', table_name || '_tenant_del', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', table_name || '_owner', tbl);
  END
  $$;

-- The switch (run by the owner, `pnpm db:rls:enforce`): ENABLE and FORCE row security on every table of the public schema that
-- has a <table>_tenant policy, or only on the tables named in `only`. `on = false` turns them all off again: that is the
-- one-minute way back. It takes a lock_timeout of 5 s and fails instead of queueing behind a long transaction (a waiting
-- ACCESS EXCLUSIVE lock blocks every query that comes after it). A function call is ONE transaction, so a failure undoes every
-- table of the call and each table kept its lock until the end: scripts/rls-enforce.ts therefore calls it once per table
-- (`only_`), and a table that times out is retried alone. Answers how many tables it changed.
CREATE FUNCTION rls_set_enforcement(on_ boolean, only_ text[] DEFAULT NULL) RETURNS integer
  LANGUAGE plpgsql
  AS $$
  DECLARE
    rel regclass;
    changed integer := 0;
  BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    FOR rel IN
      SELECT DISTINCT c.oid::regclass
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND p.polname = c.relname || '_tenant'
        AND (only_ IS NULL OR c.relname = ANY (only_))
    LOOP
      IF on_ THEN
        EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', rel);
        EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', rel);
      ELSE
        EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', rel);
        EXECUTE format('ALTER TABLE %s DISABLE ROW LEVEL SECURITY', rel);
      END IF;
      changed := changed + 1;
    END LOOP;
    RETURN changed;
  END
  $$;

-- What is protected right now, for the operator and for the database suite
CREATE VIEW rls_status AS
  SELECT c.relname::text AS table_name,
         c.relrowsecurity AS enabled,
         c.relforcerowsecurity AS forced,
         (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::integer AS policies
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = c.relname || '_tenant');

-- The application roles read the context through the functions and nothing else. Only the owner switches and applies.
REVOKE ALL ON FUNCTION rls_apply_policy(regclass, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rls_drop_policy(regclass) FROM PUBLIC;
REVOKE ALL ON FUNCTION rls_set_enforcement(boolean, text[]) FROM PUBLIC;
REVOKE ALL ON TABLE rls_status FROM PUBLIC, platform_app, platform_worker;
GRANT EXECUTE ON FUNCTION app_store_ids(), app_organization_ids() TO platform_app, platform_worker;
