-- Row-Level Security, phase 5 (worker): the lists that a scheduler walks before it can name a store. The worker is going to lose
-- BYPASSRLS, and the tables below have a policy, so a plain query of the worker would answer no row. Each list is a function that
-- returns the least (ids, never a secret or a column of content), runs as the owner (SECURITY DEFINER, fixed search_path with
-- pg_temp last), reads only, and is granted to platform_worker alone: the api has its context from the TenantGuard and must not be
-- able to ask which stores own which rows.
--
-- A list is a PAGE by key (rows after p_after, at most p_limit, ordered by the key). The caller walks the pages until one comes back
-- shorter than p_limit; a limit that cut the list in silence would process only the first rows, which is the same silent failure
-- as a query with no context. A p_limit outside 1..1000 is an error, never a clamp, so the caller cannot believe it got everything.
-- Values that the code owns (the names of the states) come as parameters, so the constants stay in libs/core/domain.

CREATE FUNCTION rls_check_page_limit(p_limit integer) RETURNS void
  LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
      RAISE EXCEPTION 'the page of a list is 1 to 1000 rows' USING ERRCODE = '22023';
    END IF;
  END
  $$;

-- The reports that are switched on, to see which are due (frequency, zone and hour are read later, inside the context of the store)
CREATE FUNCTION rls_list_enabled_scheduled_reports(p_after text, p_limit integer)
  RETURNS TABLE (id text, store_id text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    PERFORM public.rls_check_page_limit(p_limit);
    RETURN QUERY
      SELECT r.id, r.store_id FROM public.scheduled_reports r
      WHERE r.enabled AND (p_after IS NULL OR r.id > p_after)
      ORDER BY r.id LIMIT p_limit;
  END
  $$;

-- The (connection, store) pairs with a package of the carrier that is still on its way: outbound, with a guide number, in one of the
-- polled statuses, on an active connection
CREATE FUNCTION rls_list_shipment_poll_targets(
  p_kind text, p_statuses text[], p_connection_status text, p_after text, p_limit integer
) RETURNS TABLE (connection_id text, store_id text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    PERFORM public.rls_check_page_limit(p_limit);
    RETURN QUERY
      SELECT DISTINCT s.connection_id, s.store_id
      FROM public.shipments s
      JOIN public.carrier_connections c ON c.id = s.connection_id
      WHERE s.kind = p_kind AND s.status = ANY (p_statuses) AND s.guide_number IS NOT NULL
        AND c.status = p_connection_status
        AND (p_after IS NULL OR s.connection_id > p_after)
      ORDER BY s.connection_id, s.store_id LIMIT p_limit;
  END
  $$;

-- The connections whose guide benefit is on
CREATE FUNCTION rls_list_benefit_close_targets(p_connection_status text, p_after text, p_limit integer)
  RETURNS TABLE (connection_id text, store_id text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    PERFORM public.rls_check_page_limit(p_limit);
    RETURN QUERY
      SELECT g.connection_id, g.store_id
      FROM public.carrier_guide_policies g
      JOIN public.carrier_connections c ON c.id = g.connection_id
      WHERE g.benefit_enabled AND c.status = p_connection_status
        AND (p_after IS NULL OR g.connection_id > p_after)
      ORDER BY g.connection_id LIMIT p_limit;
  END
  $$;

-- The connections that make pickups
CREATE FUNCTION rls_list_pickup_targets(p_connection_status text, p_after text, p_limit integer)
  RETURNS TABLE (id text, store_id text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    PERFORM public.rls_check_page_limit(p_limit);
    RETURN QUERY
      SELECT c.id, c.store_id FROM public.carrier_connections c
      WHERE c.status = p_connection_status AND c.pickup_enabled
        AND (p_after IS NULL OR c.id > p_after)
      ORDER BY c.id LIMIT p_limit;
  END
  $$;

-- The channel connections in one of the given states whose installation and plugin are active (the health rounds and the token
-- check); updated_at comes back so that the caller can ask the one checked longest ago first
CREATE FUNCTION rls_list_active_channel_connections(
  p_statuses text[], p_installation_status text, p_plugin_status text, p_after text, p_limit integer
) RETURNS TABLE (id text, store_id text, plugin_id text, updated_at timestamp)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    PERFORM public.rls_check_page_limit(p_limit);
    RETURN QUERY
      SELECT c.id, c.store_id, c.plugin_id, c.updated_at
      FROM public.channel_connections c
      JOIN public.plugin_installations i ON i.id = c.installation_id
      JOIN public.plugins p ON p.id = i.plugin_id
      WHERE c.status = ANY (p_statuses) AND i.status = p_installation_status AND p.status = p_plugin_status
        AND (p_after IS NULL OR c.id > p_after)
      ORDER BY c.id LIMIT p_limit;
  END
  $$;

-- The people with a notification that waits for an e-mail (the frequency of each is read from the tables that are global)
CREATE FUNCTION rls_list_users_with_pending_email(p_after text, p_limit integer)
  RETURNS TABLE (user_id text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    PERFORM public.rls_check_page_limit(p_limit);
    RETURN QUERY
      SELECT DISTINCT n.user_id FROM public.notifications n
      WHERE n.email_pending_at IS NOT NULL AND (p_after IS NULL OR n.user_id > p_after)
      ORDER BY n.user_id LIMIT p_limit;
  END
  $$;

REVOKE ALL ON FUNCTION rls_check_page_limit(integer),
  rls_list_enabled_scheduled_reports(text, integer),
  rls_list_shipment_poll_targets(text, text[], text, text, integer),
  rls_list_benefit_close_targets(text, text, integer),
  rls_list_pickup_targets(text, text, integer),
  rls_list_active_channel_connections(text[], text, text, text, integer),
  rls_list_users_with_pending_email(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  rls_list_enabled_scheduled_reports(text, integer),
  rls_list_shipment_poll_targets(text, text[], text, text, integer),
  rls_list_benefit_close_targets(text, text, integer),
  rls_list_pickup_targets(text, text, integer),
  rls_list_active_channel_connections(text[], text, text, text, integer),
  rls_list_users_with_pending_email(text, integer) TO platform_worker;
-- the page check is called by the lists, which run as the owner: nobody else needs to
