-- Row-Level Security, search (plan B), the LIST of customers and its export. With the policies enforced, Postgres does not push a LIKE
-- / ILIKE that is not LEAKPROOF below the row policy, so the OR of name, email and phone of the list stopped reading the trigram
-- indexes of `customers` (the store index and a filter instead: measured in CI, plan-notas-76.md). The text search of the list goes
-- through these two functions, the same pattern as rls_search_functions: SECURITY DEFINER (they run as the owner of the table, whose
-- <table>_owner policy lets every row through), read only, and they filter by THEMSELVES what the policy would: the store is the one of
-- the transaction context (app_store_ids(), read ONCE into a variable so that a custom plan sees the value and the condition on the
-- store is an index condition), never an argument. A call with no store in the context raises SEARCH_CONTEXT_REQUIRED instead of
-- answering empty. The statements are planned with the real values of each call (force_custom_plan).
-- The patterns come from the code, already folded and escaped, and are ALWAYS bind parameters. A NULL pattern drops its column (the
-- name when the text folds to nothing, the phone when the text is not a phone). The email pattern is required: it is what a search
-- text always has.
-- The list is a PAGE by key: the rows after the cursor, in the order of the screen (newest first) or of the export (by id), at most
-- p_limit. A p_limit outside 1..1000 is an error, never a clamp. The caller reads the rows with the ids it got, so what the screen
-- shows is still decided by Prisma (select, relations); only the choice of WHICH customers is here.
-- The api calls them with the context of its request and the export of the worker with the context of the store of the export, so
-- both roles may call them (the worker is going to lose BYPASSRLS). Every table is qualified and the search_path ends in pg_temp.

CREATE FUNCTION public.rls_search_customer_list(
  p_name text,
  p_email text,
  p_phone text,
  p_by_id boolean,
  p_after_created_at text,
  p_after_id text,
  p_limit integer
) RETURNS TABLE (id text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp SET plan_cache_mode = force_custom_plan
  AS $$
  #variable_conflict use_column
  DECLARE
    v_stores text[] := public.app_store_ids();
    -- The cursor of the list (newest first) is a point in (created_at, id); the text is read in UTC, as the column is stored
    v_after_at public.customers.created_at%TYPE := p_after_created_at::public.customers.created_at%TYPE;
  BEGIN
    IF cardinality(v_stores) = 0 THEN
      RAISE EXCEPTION 'SEARCH_CONTEXT_REQUIRED' USING ERRCODE = '42501';
    END IF;
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
      RAISE EXCEPTION 'the page of a list is 1 to 1000 rows' USING ERRCODE = '22023';
    END IF;
    IF p_email IS NULL THEN
      RAISE EXCEPTION 'SEARCH_EMAIL_PATTERN_REQUIRED' USING ERRCODE = '22023';
    END IF;
    IF p_by_id THEN
      RETURN QUERY
      SELECT c.id
      FROM public.customers c
      WHERE c.store_id = ANY (v_stores)
        AND c.merged_into_id IS NULL
        AND (
          (p_name IS NOT NULL AND c.name_search LIKE p_name ESCAPE '\')
          OR c.email ILIKE p_email ESCAPE '\'
          OR (p_phone IS NOT NULL AND c.phone_normalized LIKE p_phone ESCAPE '\')
        )
        AND (p_after_id IS NULL OR c.id > p_after_id)
      ORDER BY c.id ASC
      LIMIT p_limit;
    ELSE
      RETURN QUERY
      SELECT c.id
      FROM public.customers c
      WHERE c.store_id = ANY (v_stores)
        AND c.merged_into_id IS NULL
        AND (
          (p_name IS NOT NULL AND c.name_search LIKE p_name ESCAPE '\')
          OR c.email ILIKE p_email ESCAPE '\'
          OR (p_phone IS NOT NULL AND c.phone_normalized LIKE p_phone ESCAPE '\')
        )
        AND (
          p_after_id IS NULL
          OR c.created_at < v_after_at
          OR (c.created_at = v_after_at AND c.id < p_after_id)
        )
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT p_limit;
    END IF;
  END
  $$;

-- How many customers a search text finds (the count of the export)
CREATE FUNCTION public.rls_count_customer_list(
  p_name text,
  p_email text,
  p_phone text
) RETURNS bigint
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp SET plan_cache_mode = force_custom_plan
  AS $$
  #variable_conflict use_column
  DECLARE
    v_stores text[] := public.app_store_ids();
    v_count bigint;
  BEGIN
    IF cardinality(v_stores) = 0 THEN
      RAISE EXCEPTION 'SEARCH_CONTEXT_REQUIRED' USING ERRCODE = '42501';
    END IF;
    IF p_email IS NULL THEN
      RAISE EXCEPTION 'SEARCH_EMAIL_PATTERN_REQUIRED' USING ERRCODE = '22023';
    END IF;
    SELECT count(*) INTO v_count
    FROM public.customers c
    WHERE c.store_id = ANY (v_stores)
      AND c.merged_into_id IS NULL
      AND (
        (p_name IS NOT NULL AND c.name_search LIKE p_name ESCAPE '\')
        OR c.email ILIKE p_email ESCAPE '\'
        OR (p_phone IS NOT NULL AND c.phone_normalized LIKE p_phone ESCAPE '\')
      );
    RETURN v_count;
  END
  $$;

REVOKE ALL ON FUNCTION
  public.rls_search_customer_list(text, text, text, boolean, text, text, integer),
  public.rls_count_customer_list(text, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  public.rls_search_customer_list(text, text, text, boolean, text, text, integer),
  public.rls_count_customer_list(text, text, text)
  TO platform_app, platform_worker;
