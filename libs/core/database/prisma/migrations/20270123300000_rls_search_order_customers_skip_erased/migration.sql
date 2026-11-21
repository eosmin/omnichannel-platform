-- rls_search_order_customers found a customer who asked to be forgotten (erased_at set) by whatever name, e-mail or phone was still on the
-- row, which the other search functions never do (rls_search_customers, rls_search_orders by customer, the duplicate finder all skip
-- `erased_at IS NOT NULL`). It now skips them too: an order of an erased customer is no longer found by the person's text. An absorbed
-- (merged) customer is still found, the order keeps pointing at who made it. Same signature, same grants (re-stated), same search_path
-- (pg_temp last), same SQLSTATEs. No table changes: nothing for rls_extend_policies_to_replica() to extend.
-- Rollback: rollbacks/20270123300000_rls_search_order_customers_skip_erased.rollback.sql (puts back the previous body).

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

REVOKE ALL ON FUNCTION public.rls_search_order_customers(text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rls_search_order_customers(text, text, text, integer) TO platform_app, platform_worker;
