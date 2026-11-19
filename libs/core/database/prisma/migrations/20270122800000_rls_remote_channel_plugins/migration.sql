-- Row-Level Security, phase 5 (worker), B2c: RemoteChannelSync keeps the registry of the remote channel plugins of a process. The api AND
-- the worker run it, at start, on a message of Redis and every 60 seconds, with no request and no job around it, so with no context. It
-- needs every private channel plugin that has an ACTIVE installation in ANY store, and the stores that installed it: a read that crosses
-- stores. With row security on for plugin_installations a plain query answers no row, and the registry, which takes "nothing" for "nobody
-- has it installed", would drop every adapter. So the read is one SECURITY DEFINER function (fixed search_path with pg_temp last,
-- qualified objects, reads only), a PAGE by plugin id like the other lists of the phase (a p_limit outside 1..1000 is an error, never a
-- clamp; the filters are required, never defaulted).
--
-- Unlike the lists of the worker, this one is granted to platform_app too, because the api process runs the same service. What it
-- returns is what the registry needs and nothing else: the id and the manifest of the plugin (public by design, TDD_10 §6.1) and the ids
-- of the stores that installed it. Never a secret: the command secret of an installation is read in the context of its store (readSecrets).
-- No policy is created or changed here, so rls_extend_policies_to_replica() has nothing to extend.

CREATE FUNCTION rls_list_remote_channel_plugins(
  p_type text, p_status text, p_install_status text, p_after text, p_limit integer
) RETURNS TABLE (id text, manifest jsonb, store_ids text[])
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    PERFORM public.rls_check_page_limit(p_limit);
    IF p_type IS NULL OR p_status IS NULL OR p_install_status IS NULL THEN
      RAISE EXCEPTION 'the filter of the remote channel plugins is required' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY
      SELECT p.id, p.manifest, array_agg(i.store_id ORDER BY i.store_id)
      FROM public.plugins p
      JOIN public.plugin_installations i ON i.plugin_id = p.id
      WHERE p.type = p_type AND NOT p.is_official AND p.status = p_status AND i.status = p_install_status
        AND (p_after IS NULL OR p.id > p_after)
      GROUP BY p.id
      ORDER BY p.id LIMIT p_limit;
  END
  $$;

REVOKE ALL ON FUNCTION rls_list_remote_channel_plugins(text, text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rls_list_remote_channel_plugins(text, text, text, text, integer)
  TO platform_app, platform_worker;
