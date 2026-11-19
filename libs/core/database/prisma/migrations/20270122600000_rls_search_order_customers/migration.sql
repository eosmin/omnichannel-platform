-- Row-Level Security, search (plan B), the ORDERS list and its export. The text of the orders list finds an order by its number (a
-- prefix, on the orders table: a b-tree, no problem) OR by who it is for: the name, the e-mail or the phone of the customer, which
-- Prisma wrote as a sub-select on `customers`. With the policies enforced that sub-select cannot read the trigram indexes of
-- `customers` (the LIKE / ILIKE are not LEAKPROOF, so they cannot be index conditions next to the policy). The customers of the text
-- are therefore found by this read-only SECURITY DEFINER function, the same pattern as rls_search_customer_list and
-- rls_search_product_matches: it runs as the owner of the table (whose <table>_owner policy lets every row through), filters by
-- ITSELF what the policy would (the store is the one of the transaction context, app_store_ids() read ONCE into a variable, never an
-- argument; no context raises SEARCH_CONTEXT_REQUIRED) and is planned with the real values (force_custom_plan). The caller then reads
-- the orders of those customers by `customer_id IN (ids)` with its other filters, as before.
-- The answer is bounded here: at most p_limit ids (1 to 10001). The caller asks for one more than it accepts and REFUSES a text that is
-- too wide (SEARCH_TOO_BROAD, a 400 that asks to type more): a truncated answer would be an order list that silently lacks orders.
-- An absorbed (merged) customer is included: the order keeps pointing at who made it. The patterns are contains-patterns, escaped by
-- the caller, and always bind parameters; a NULL phone pattern drops the phone (the text is not a phone). EXECUTE goes to
-- platform_app (the list of the api) AND platform_worker (the export of orders, which runs in the worker with the context of the
-- store of the export and is going to lose BYPASSRLS); PUBLIC and the replica role have none.

CREATE FUNCTION public.rls_search_order_customers(
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
