-- Row-Level Security, phase 5 (worker), C3: the sweep of the pickup evaluator looks across every store for the pickups that no job will
-- ask again. Two lists, SECURITY DEFINER with a fixed search_path (pg_temp last), qualified objects, granted to platform_worker alone,
-- refusing a page outside 1..1000 (rls_check_page_limit, never a clamp). They return ids and nothing else; the queue gets one job per
-- row and each job runs in the context of its own store. The rows come OLDEST first and the caller takes one batch, as before.
-- No policy is created or changed here, so rls_extend_policies_to_replica() has nothing to extend.

-- A pickup left PENDING (the queue was down or its job was lost), created before the cutoff, of a day that is not over
CREATE FUNCTION rls_list_pickups_pending_stale(
  p_status text, p_created_before timestamp, p_date_from date, p_limit integer
) RETURNS TABLE (id text, store_id text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    PERFORM public.rls_check_page_limit(p_limit);
    IF p_status IS NULL OR p_created_before IS NULL OR p_date_from IS NULL THEN
      RAISE EXCEPTION 'the filter of the pickup sweep is required' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY
      SELECT p.id, p.store_id FROM public.pickup_requests p
      WHERE p.status = p_status AND p.created_at < p_created_before AND p.pickup_date >= p_date_from
      ORDER BY p.created_at ASC, p.id ASC LIMIT p_limit;
  END
  $$;

-- A pickup whose count the carrier has not acknowledged for a while (changes that landed out of order, a carrier that did not answer)
CREATE FUNCTION rls_list_pickups_count_behind(
  p_statuses text[], p_date_from date, p_updated_before timestamp, p_limit integer
) RETURNS TABLE (id text, store_id text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    PERFORM public.rls_check_page_limit(p_limit);
    IF p_statuses IS NULL OR p_date_from IS NULL OR p_updated_before IS NULL THEN
      RAISE EXCEPTION 'the filter of the pickup sweep is required' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY
      SELECT p.id, p.store_id FROM public.pickup_requests p
      WHERE p.status = ANY (p_statuses)
        AND p.provider_pickup_id IS NOT NULL
        AND p.carrier_package_count IS NOT NULL
        AND p.carrier_package_count <> p.package_count
        AND p.package_count > 0
        AND p.pickup_date >= p_date_from
        AND p.updated_at < p_updated_before
      ORDER BY p.updated_at ASC, p.id ASC LIMIT p_limit;
  END
  $$;

REVOKE ALL ON FUNCTION
  rls_list_pickups_pending_stale(text, timestamp, date, integer),
  rls_list_pickups_count_behind(text[], date, timestamp, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  rls_list_pickups_pending_stale(text, timestamp, date, integer),
  rls_list_pickups_count_behind(text[], date, timestamp, integer) TO platform_worker;
