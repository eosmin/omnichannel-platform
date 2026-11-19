-- The lookups that run BEFORE a tenant context exists (RLS phase 6, F6-3b), hardened. Same four functions, same signatures and
-- grants (CREATE OR REPLACE keeps them), same three-id answer. What changes:
--   * search_path = pg_catalog, public, pg_temp, with every object schema-qualified: nothing a session creates in pg_temp or earlier
--     in the path can stand in for a table or an operator the owner's function reads;
--   * resolve_api_key answers only a key that can still open a door (status 'active', not revoked, not expired) and
--     resolve_widget_site only an active connection: a revoked key or a disconnected site opens no context at all, instead of
--     opening one and being refused afterwards. The code still checks the row inside the context (the answer of a cache or of a
--     replica lags a revocation by a moment);
--   * resolve_plugin_installation and resolve_carrier_connection keep answering a row in any state: the guard audits a refusal of an
--     inactive installation by its id, and a carrier's webhook for a paused connection is still acknowledged by the code.
-- A statement with no context sees nothing of the tables: these four are the only way a caller finds a store from a secret.

CREATE OR REPLACE FUNCTION public.resolve_widget_site(p_plugin_id text, p_site_key text)
  RETURNS TABLE (id text, store_id text, organization_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT c.id, c.store_id, s.organization_id
    FROM public.channel_connections c
    JOIN public.stores s ON s.id = c.store_id
    WHERE c.plugin_id = p_plugin_id AND c.connection_id = p_site_key AND c.status = 'active'
    LIMIT 1
  $$;

CREATE OR REPLACE FUNCTION public.resolve_plugin_installation(p_key_hash text)
  RETURNS TABLE (id text, store_id text, organization_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT i.id, i.store_id, s.organization_id
    FROM public.plugin_installations i
    JOIN public.stores s ON s.id = i.store_id
    WHERE i.api_key_hash = p_key_hash
    LIMIT 1
  $$;

CREATE OR REPLACE FUNCTION public.resolve_api_key(p_key_hash text)
  RETURNS TABLE (id text, store_id text, organization_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT k.id, k.store_id, s.organization_id
    FROM public.api_keys k
    JOIN public.stores s ON s.id = k.store_id
    WHERE k.key_hash = p_key_hash
      AND k.status = 'active'
      AND k.revoked_at IS NULL
      AND (k.expires_at IS NULL OR k.expires_at > pg_catalog.now())
    LIMIT 1
  $$;

CREATE OR REPLACE FUNCTION public.resolve_carrier_connection(p_connection_id text)
  RETURNS TABLE (id text, store_id text, organization_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT c.id, c.store_id, s.organization_id
    FROM public.carrier_connections c
    JOIN public.stores s ON s.id = c.store_id
    WHERE c.id = p_connection_id
    LIMIT 1
  $$;
