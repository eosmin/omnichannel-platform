-- Row-Level Security, phase 1 (TDD_01 section 3.2, layer 3): configuration, catalogs, audit and analytics tables, and the four
-- lookups that run before any tenant context exists. This migration DECLARES policies; it does not turn row security on (no
-- ENABLE, no FORCE: the owner does that with rls_set_enforcement, first in CI), so nothing changes for the application by running it.
-- Rollback: libs/core/database/rollbacks/20270121110000_rls_phase1.rollback.sql

-- 1. The standard policy (<table>_tenant) of every table of the phase that has a store_id or an organization_id.
SELECT rls_apply_policy('tags', 'store');
SELECT rls_apply_policy('snippets', 'store');
SELECT rls_apply_policy('business_hours', 'store');
SELECT rls_apply_policy('routing_rules', 'store');
SELECT rls_apply_policy('store_settings', 'store');
SELECT rls_apply_policy('retention_settings', 'store');
SELECT rls_apply_policy('notification_preferences', 'store');
SELECT rls_apply_policy('api_keys', 'store');
SELECT rls_apply_policy('webhooks', 'store');
SELECT rls_apply_policy('plugin_installations', 'store');
SELECT rls_apply_policy('scheduled_reports', 'store');
SELECT rls_apply_policy('analytics_events', 'store');
SELECT rls_apply_policy('metrics_daily', 'store');
SELECT rls_apply_policy('metrics_hourly', 'store');
SELECT rls_apply_policy('exports', 'store');
SELECT rls_apply_policy('consent_records', 'store');
-- organization_id is NOT NULL, store_id is optional (a request about the whole organization): the organization decides
SELECT rls_apply_policy('data_subject_requests', 'organization');
-- The official plugins have no organization: every context READS them, only the organization that registered a private one
-- writes it
SELECT rls_apply_policy('plugins', 'organization_or_null');

-- 2. plugins: the catalog the platform writes at boot (PluginCatalogSync) has no organization. Those rows are written with the
-- flag app.platform_catalog, which only PrismaService.catalogTransaction sets (a transaction-local set_config, like the tenant
-- context). A tenant request never sets it, so it cannot write an official plugin.
DO $$
BEGIN
  CREATE POLICY plugins_catalog_ins ON plugins AS PERMISSIVE FOR INSERT TO platform_app, platform_worker
    WITH CHECK (organization_id IS NULL AND current_setting('app.platform_catalog', true) = 'on');
  CREATE POLICY plugins_catalog_upd ON plugins AS PERMISSIVE FOR UPDATE TO platform_app, platform_worker
    USING (organization_id IS NULL AND current_setting('app.platform_catalog', true) = 'on')
    WITH CHECK (organization_id IS NULL AND current_setting('app.platform_catalog', true) = 'on');
END
$$;

-- 3. audit_logs. A row is READ only through its store (a row with no store belongs to no tenant: the actions of a person, of the
-- system and of the guards are not visible to any request). It is WRITTEN with no store or with a store of the context, so the
-- trail of a refused login or of a request for a store the person does not belong to is never refused by the database; the
-- application writes it without RETURNING (a RETURNING also has to pass the SELECT policy). UPDATE and DELETE are revoked from
-- platform_app since Step 0.4 and stay so: there is no policy for them.
DO $$
DECLARE
  owner_role name;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO owner_role FROM pg_class c WHERE c.oid = 'audit_logs'::regclass;
  CREATE POLICY audit_logs_tenant ON audit_logs AS PERMISSIVE FOR SELECT TO platform_app, platform_worker
    USING (store_id = ANY ((SELECT app_store_ids())::text[]));
  CREATE POLICY audit_logs_insert_unowned ON audit_logs AS PERMISSIVE FOR INSERT TO platform_app, platform_worker
    WITH CHECK (store_id IS NULL OR store_id = ANY ((SELECT app_store_ids())::text[]));
  EXECUTE format(
    'CREATE POLICY audit_logs_owner ON audit_logs AS PERMISSIVE FOR ALL TO %I USING (true) WITH CHECK (true)',
    owner_role
  );
END
$$;

-- 4. webhook_deliveries has no store_id: it belongs to a webhook or to a plugin installation. The predicate reads the store of the
-- parent itself (not through the policy of the parent), so it holds whether or not the parent is enforced yet.
DO $$
DECLARE
  owner_role name;
  mine text := '(
      EXISTS (SELECT 1 FROM webhooks w WHERE w.id = webhook_deliveries.webhook_id
                AND w.store_id = ANY ((SELECT app_store_ids())::text[]))
      OR EXISTS (SELECT 1 FROM plugin_installations i WHERE i.id = webhook_deliveries.plugin_installation_id
                AND i.store_id = ANY ((SELECT app_store_ids())::text[]))
    )';
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO owner_role FROM pg_class c WHERE c.oid = 'webhook_deliveries'::regclass;
  EXECUTE format(
    'CREATE POLICY webhook_deliveries_tenant ON webhook_deliveries AS PERMISSIVE FOR ALL TO platform_app, platform_worker USING (%s) WITH CHECK (%s)',
    mine, mine
  );
  EXECUTE format(
    'CREATE POLICY webhook_deliveries_owner ON webhook_deliveries AS PERMISSIVE FOR ALL TO %I USING (true) WITH CHECK (true)',
    owner_role
  );
END
$$;

-- 5. The lookups that run before there is a context. Each answers ONE row for an exact key (a hash, a site key, an id), with the
-- ids that open the context (the row, its store, the organization of the store) and nothing else: never a secret, a scope or a
-- status, which the caller reads afterwards from the row, inside the context it was just given. They belong to the owner of the
-- tables (the role of the migrations), which is not subject to the policies, and only the application roles may call them.
-- The application never passes a store: the store is what the function finds.
CREATE FUNCTION resolve_widget_site(p_plugin_id text, p_site_key text)
  RETURNS TABLE (id text, store_id text, organization_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT c.id, c.store_id, s.organization_id
    FROM channel_connections c
    JOIN stores s ON s.id = c.store_id
    WHERE c.plugin_id = p_plugin_id AND c.connection_id = p_site_key
    LIMIT 1
  $$;

CREATE FUNCTION resolve_plugin_installation(p_key_hash text)
  RETURNS TABLE (id text, store_id text, organization_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT i.id, i.store_id, s.organization_id
    FROM plugin_installations i
    JOIN stores s ON s.id = i.store_id
    WHERE i.api_key_hash = p_key_hash
    LIMIT 1
  $$;

CREATE FUNCTION resolve_api_key(p_key_hash text)
  RETURNS TABLE (id text, store_id text, organization_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT k.id, k.store_id, s.organization_id
    FROM api_keys k
    JOIN stores s ON s.id = k.store_id
    WHERE k.key_hash = p_key_hash
    LIMIT 1
  $$;

CREATE FUNCTION resolve_carrier_connection(p_connection_id text)
  RETURNS TABLE (id text, store_id text, organization_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT c.id, c.store_id, s.organization_id
    FROM carrier_connections c
    JOIN stores s ON s.id = c.store_id
    WHERE c.id = p_connection_id
    LIMIT 1
  $$;

REVOKE ALL ON FUNCTION resolve_widget_site(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_plugin_installation(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_api_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_carrier_connection(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_widget_site(text, text) TO platform_app, platform_worker;
GRANT EXECUTE ON FUNCTION resolve_plugin_installation(text) TO platform_app, platform_worker;
GRANT EXECUTE ON FUNCTION resolve_api_key(text) TO platform_app, platform_worker;
GRANT EXECUTE ON FUNCTION resolve_carrier_connection(text) TO platform_app, platform_worker;
