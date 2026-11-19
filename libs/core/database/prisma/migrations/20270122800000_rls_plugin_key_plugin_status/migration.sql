-- PluginApiKeyGuard under row-level security: the guard read the status of the plugin of an installation with a nested select inside
-- the context of the store of the key. `plugins` has the policy organization_or_null, so a plugin registered by another organization
-- is not visible there, the nested row came back null and the guard answered 500 instead of refusing the key.
-- This function answers the status of that plugin (and nothing else) for an exact key hash, the way resolve_plugin_installation
-- answers the store: the input is the hash of a secret the caller holds, never a store or a plugin id, there is no context to read,
-- and a hash that matches no installation (or an installation with no plugin row) answers no row, which the guard turns into the
-- same 401 as an unknown key. Objects are schema-qualified and pg_temp is last in the search_path.
CREATE OR REPLACE FUNCTION public.lookup_plugin_status_of_key(p_key_hash text)
  RETURNS TABLE (plugin_status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT p.status
    FROM public.plugin_installations i
    JOIN public.plugins p ON p.id = i.plugin_id
    WHERE i.api_key_hash = p_key_hash
    LIMIT 1
  $$;

REVOKE ALL ON FUNCTION public.lookup_plugin_status_of_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_plugin_status_of_key(text) TO platform_app, platform_worker;
