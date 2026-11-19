-- Rollback of 20270122200000_rls_resolvers_live_rows: the four lookups go back to the definitions of 20270121110000_rls_phase1
-- (every row in any state, search_path = public, pg_temp). Idempotent: CREATE OR REPLACE; grants are kept. The code does not depend
-- on the stricter answer (it checks status and expiry inside the context), so nothing else has to go first.
CREATE OR REPLACE FUNCTION public.resolve_widget_site(p_plugin_id text, p_site_key text)
  RETURNS TABLE (id text, store_id text, organization_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT c.id, c.store_id, s.organization_id
    FROM channel_connections c
    JOIN stores s ON s.id = c.store_id
    WHERE c.plugin_id = p_plugin_id AND c.connection_id = p_site_key
    LIMIT 1
  $$;

CREATE OR REPLACE FUNCTION public.resolve_plugin_installation(p_key_hash text)
  RETURNS TABLE (id text, store_id text, organization_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT i.id, i.store_id, s.organization_id
    FROM plugin_installations i
    JOIN stores s ON s.id = i.store_id
    WHERE i.api_key_hash = p_key_hash
    LIMIT 1
  $$;

CREATE OR REPLACE FUNCTION public.resolve_api_key(p_key_hash text)
  RETURNS TABLE (id text, store_id text, organization_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT k.id, k.store_id, s.organization_id
    FROM api_keys k
    JOIN stores s ON s.id = k.store_id
    WHERE k.key_hash = p_key_hash
    LIMIT 1
  $$;

CREATE OR REPLACE FUNCTION public.resolve_carrier_connection(p_connection_id text)
  RETURNS TABLE (id text, store_id text, organization_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT c.id, c.store_id, s.organization_id
    FROM carrier_connections c
    JOIN stores s ON s.id = c.store_id
    WHERE c.id = p_connection_id
    LIMIT 1
  $$;
