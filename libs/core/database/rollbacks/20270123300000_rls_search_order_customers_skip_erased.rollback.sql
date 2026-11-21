-- Rollback of 20270123300000_rls_search_order_customers_skip_erased: puts back the body of 20270122600000 (an erased customer is found
-- again). Idempotent; the grants stay as they were.
CREATE OR REPLACE FUNCTION public.rls_search_order_customers(
  p_name text,
  p_email text,
  p_phone text,
  p_limit integer
) RETURNS TABLE (id text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp SET plan_cache_mode = force_custom_plan
  AS $$
  #variable_conflict use_column
  DECLARE
    v_stores text[] := public.app_store_ids();
  BEGIN
    IF cardinality(v_stores) = 0 THEN
      RAISE EXCEPTION 'SEARCH_CONTEXT_REQUIRED' USING ERRCODE = '42501';
    END IF;
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10001 THEN
      RAISE EXCEPTION 'SEARCH_LIMIT_INVALID' USING ERRCODE = '22023';
    END IF;
    IF p_name IS NULL OR p_email IS NULL THEN
      RAISE EXCEPTION 'SEARCH_PATTERN_REQUIRED' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY
    SELECT c.id
    FROM public.customers c
    WHERE c.store_id = ANY (v_stores)
      AND c.erased_at IS NULL
      AND (
        c.name ILIKE p_name ESCAPE '\'
        OR c.email ILIKE p_email ESCAPE '\'
        OR (p_phone IS NOT NULL AND c.phone_normalized LIKE p_phone ESCAPE '\')
      )
    LIMIT p_limit;
  END
  $$;
