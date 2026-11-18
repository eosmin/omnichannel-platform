-- Row-Level Security, phase 0b (worker): the lookups a job makes BEFORE it can name its store. They are the only places where the
-- store is learnt from a row id (or from the pair a channel event carries), so they are functions that return the least, run as
-- the owner (SECURITY DEFINER, with a fixed search_path), and are granted to the two application roles only. A function answers
-- NULL / no row for an id that does not exist; the caller treats that as an error, never as "nothing to do" (fail closed).

-- The store of a file (NULL for the avatar of a person, which has none: the job then acts for a user)
CREATE FUNCTION rls_store_of_media(p_id text) RETURNS TABLE (found boolean, store_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
    SELECT true, m.store_id FROM media m WHERE m.id = p_id
  $$;

CREATE FUNCTION rls_store_of_export(p_id text) RETURNS TABLE (found boolean, store_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
    SELECT true, e.store_id FROM exports e WHERE e.id = p_id
  $$;

CREATE FUNCTION rls_store_of_scheduled_report(p_id text) RETURNS TABLE (found boolean, store_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
    SELECT true, r.store_id FROM scheduled_reports r WHERE r.id = p_id
  $$;

-- The store that owns the recipient of a channel event: the connection found by (plugin, connection id), with the statuses the
-- caller needs to say whether it is active. Nothing else of the connection leaves (no credentials, no metadata).
CREATE FUNCTION rls_resolve_channel_connection(p_plugin_id text, p_connection_id text)
  RETURNS TABLE (id text, store_id text, status text, installation_status text, plugin_status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
    SELECT c.id, c.store_id, c.status, i.status, p.status
    FROM channel_connections c
    JOIN plugin_installations i ON i.id = c.installation_id
    JOIN plugins p ON p.id = i.plugin_id
    WHERE c.plugin_id = p_plugin_id AND c.connection_id = p_connection_id
  $$;

REVOKE ALL ON FUNCTION rls_store_of_media(text), rls_store_of_export(text), rls_store_of_scheduled_report(text),
  rls_resolve_channel_connection(text, text) FROM PUBLIC;
-- The three that learn the store of any id are the worker's alone: the api always has the store from the TenantGuard, and a role of the
-- request path must not be able to ask which store owns an arbitrary id. The channel lookup is also the api's (the public webhooks and
-- the outbound targets resolve a connection before any context), as the query it replaces was.
GRANT EXECUTE ON FUNCTION rls_store_of_media(text), rls_store_of_export(text), rls_store_of_scheduled_report(text) TO platform_worker;
GRANT EXECUTE ON FUNCTION rls_resolve_channel_connection(text, text) TO platform_app, platform_worker;
