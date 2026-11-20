-- Registering a private plugin under row-level security (PR B of the plugins): before it fetches the icon of a manifest from the
-- network, PluginRegistrationService asks whether the id is held by an owner that is NOT the caller's organization (another
-- organization's plugin, or an official one). Before RLS that was a plain read of `plugins`; with the policy organization_or_null the
-- row of another organization is invisible, the read answers "no row" and the service would fetch an address of the manifest for an id
-- that is not the caller's: a request to the network, chosen by the caller, for a plugin it can never write. That is a difference in
-- behavior with a surface of server-side request forgery, so the protection is kept with the least that can answer it.
--
-- This function answers ONE boolean for ONE plugin id and nothing else (no organization, no status, no manifest):
--   true  = the plugin exists and its organization is NOT one of the context's (another organization's, or no organization at all)
--   false = it does not exist, or it is the organization's own. "Mine" and "free" answer the same, so the function does not tell a
--           caller anything about an id that the caller could not already register.
-- The only parameter is the plugin id the caller already holds; the organization is read from the context ONCE into a variable (never
-- a parameter that could be forged) and no context is an error. Objects are schema-qualified and pg_temp is last in the search_path.
-- Granted to platform_app alone: the worker never registers a plugin. No policy is created or changed here, so
-- rls_extend_policies_to_replica() has nothing to extend.

CREATE FUNCTION public.rls_plugin_foreign_owner(p_id text) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_orgs text[] := public.app_organization_ids();
  BEGIN
    IF p_id IS NULL THEN
      RAISE EXCEPTION 'the plugin id is required' USING ERRCODE = '22023';
    END IF;
    IF cardinality(v_orgs) = 0 THEN
      RAISE EXCEPTION 'no organization in the context' USING ERRCODE = '42501';
    END IF;
    RETURN EXISTS (
      SELECT 1 FROM public.plugins p
      WHERE p.id = p_id AND (p.organization_id IS NULL OR NOT (p.organization_id = ANY (v_orgs)))
    );
  END
  $$;

REVOKE ALL ON FUNCTION public.rls_plugin_foreign_owner(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rls_plugin_foreign_owner(text) TO platform_app;
