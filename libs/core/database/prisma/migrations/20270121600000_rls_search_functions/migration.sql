-- Row-Level Security, search (plan B). With the policies enforced, Postgres does not push a text-search or trigram operator that is
-- not LEAKPROOF below the row policy, so the search of messages, customers and orders stopped using its GIN indexes (a filter on the
-- store index instead). The reads of the search therefore go through these functions: SECURITY DEFINER (they run as the owner of
-- the tables, whose <table>_owner policy lets every row through, so the planner is free to use the index), read-only, and they
-- filter by THEMSELVES what the policy would: the store is the one of the transaction context (app_store_ids()), never an argument,
-- and the person is app_user_id(). A call with no store in the context raises SEARCH_CONTEXT_REQUIRED instead of answering empty: a
-- search that is silently empty for want of a context is the failure the tenant guard exists to catch. The permissions of the person
-- (see all, see hidden, read notes, read orders) come from the caller as booleans: they are the authorization of the code, as before.
-- The statements are planned with the real values of each call (SET plan_cache_mode = force_custom_plan): plpgsql would otherwise
-- cache the plan and may turn to a generic one after five calls on a connection, which can lose the index again. A SQL function would
-- not be inlined either, being SECURITY DEFINER, so it has the same generic-plan risk; plpgsql is for the check of the context.
-- Every table and our own function is qualified (the operators and functions of pg_trgm resolve through the public schema of the search_path) and the search_path ends in pg_temp (pnpm validate:definer). The role of the api may call them; the
-- worker does not search.

CREATE FUNCTION public.rls_search_messages(
  p_q text,
  p_limit integer,
  p_candidates integer,
  p_conversation_id text,
  p_can_view_all boolean,
  p_can_see_hidden boolean,
  p_can_read_notes boolean,
  p_can_read_orders boolean,
  p_hidden text[],
  p_system text,
  p_note text,
  p_order_summary text,
  p_snippet_options text
) RETURNS TABLE (
  id text,
  conversation_id text,
  type text,
  created_at public.messages.created_at%TYPE,
  customer_id text,
  customer_name text,
  snippet text
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp SET plan_cache_mode = force_custom_plan
  AS $$
  #variable_conflict use_column
  BEGIN
    IF cardinality(public.app_store_ids()) = 0 THEN
      RAISE EXCEPTION 'SEARCH_CONTEXT_REQUIRED' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    WITH q AS (
      SELECT
        websearch_to_tsquery('spanish'::regconfig, public.immutable_unaccent(p_q)) AS folded,
        websearch_to_tsquery('spanish'::regconfig, p_q)
          || websearch_to_tsquery('spanish'::regconfig, public.immutable_unaccent(p_q)) AS marked
    ),
    candidates AS (
      SELECT m.id, m.conversation_id, m.type, m.created_at, m.content, c.customer_id,
        to_tsvector('spanish'::regconfig, public.immutable_unaccent(coalesce(m.content, ''))) AS vector
      FROM public.messages m
      JOIN public.conversations c ON c.id = m.conversation_id AND c.store_id = m.store_id
      JOIN public.customers cust ON cust.id = c.customer_id AND cust.store_id = c.store_id
      CROSS JOIN q
      WHERE m.store_id = ANY ((SELECT public.app_store_ids())::text[])
        AND m.deleted_at IS NULL
        AND m.discarded_at IS NULL
        AND m.type <> p_system
        AND cust.erased_at IS NULL
        AND (p_can_read_notes OR m.type <> p_note)
        AND (p_can_read_orders OR m.type <> p_order_summary)
        AND (p_can_view_all OR c.assigned_to IS NULL OR c.assigned_to = (SELECT public.app_user_id()))
        AND (p_can_see_hidden OR NOT (c.status = ANY (p_hidden)))
        AND (p_conversation_id IS NULL OR m.conversation_id = p_conversation_id)
        AND to_tsvector('spanish'::regconfig, public.immutable_unaccent(coalesce(m.content, ''))) @@ q.folded
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT p_candidates
    ),
    page AS (
      SELECT cand.*, ts_rank(cand.vector, q.folded) AS rank
      FROM candidates cand CROSS JOIN q
      ORDER BY rank DESC, cand.created_at DESC, cand.id DESC
      LIMIT p_limit + 1
    )
    SELECT
      page.id, page.conversation_id, page.type, page.created_at,
      cust.id, cust.name,
      ts_headline('spanish'::regconfig, page.content, q.marked, p_snippet_options)
    FROM page
    CROSS JOIN q
    JOIN public.customers cust ON cust.id = page.customer_id AND cust.store_id = ANY ((SELECT public.app_store_ids())::text[])
    ORDER BY page.rank DESC, page.created_at DESC, page.id DESC;
  END
  $$;

-- The messages that contain a text made only of words the index drops (stop words) or only of symbols, read as typed. `p_contains` is
-- the LIKE pattern, already folded and escaped by the caller.
CREATE FUNCTION public.rls_search_messages_typed(
  p_contains text,
  p_q text,
  p_limit integer,
  p_conversation_id text,
  p_can_view_all boolean,
  p_can_see_hidden boolean,
  p_can_read_notes boolean,
  p_can_read_orders boolean,
  p_hidden text[],
  p_system text,
  p_note text,
  p_order_summary text,
  p_snippet_options text
) RETURNS TABLE (
  id text,
  conversation_id text,
  type text,
  created_at public.messages.created_at%TYPE,
  customer_id text,
  customer_name text,
  snippet text
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp SET plan_cache_mode = force_custom_plan
  AS $$
  #variable_conflict use_column
  BEGIN
    IF cardinality(public.app_store_ids()) = 0 THEN
      RAISE EXCEPTION 'SEARCH_CONTEXT_REQUIRED' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    WITH candidates AS (
      SELECT m.id, m.conversation_id, m.type, m.created_at, m.content, c.customer_id
      FROM public.messages m
      JOIN public.conversations c ON c.id = m.conversation_id AND c.store_id = m.store_id
      JOIN public.customers cust ON cust.id = c.customer_id AND cust.store_id = c.store_id
      WHERE m.store_id = ANY ((SELECT public.app_store_ids())::text[])
        AND m.deleted_at IS NULL
        AND m.discarded_at IS NULL
        AND m.type <> p_system
        AND cust.erased_at IS NULL
        AND (p_can_read_notes OR m.type <> p_note)
        AND (p_can_read_orders OR m.type <> p_order_summary)
        AND (p_can_view_all OR c.assigned_to IS NULL OR c.assigned_to = (SELECT public.app_user_id()))
        AND (p_can_see_hidden OR NOT (c.status = ANY (p_hidden)))
        AND (p_conversation_id IS NULL OR m.conversation_id = p_conversation_id)
        AND lower(public.immutable_unaccent(coalesce(m.content, ''))) LIKE p_contains ESCAPE '\'
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT p_limit + 1
    )
    SELECT
      cand.id, cand.conversation_id, cand.type, cand.created_at,
      cust.id, cust.name,
      ts_headline(
        'simple'::regconfig, cand.content,
        websearch_to_tsquery('simple'::regconfig, p_q)
          || websearch_to_tsquery('simple'::regconfig, public.immutable_unaccent(p_q)),
        p_snippet_options
      )
    FROM candidates cand
    JOIN public.customers cust ON cust.id = cand.customer_id AND cust.store_id = ANY ((SELECT public.app_store_ids())::text[])
    ORDER BY cand.created_at DESC, cand.id DESC;
  END
  $$;

-- Customers by name (a part of it, or a typo), by email and by a run of digits of the phone. The patterns and the thresholds come from
-- the caller (the constants of the platform); the text arrives folded.
CREATE FUNCTION public.rls_search_customers(
  p_folded text,
  p_contains text,
  p_starts_with text,
  p_typed text,
  p_phone_like text,
  p_by_phone boolean,
  p_by_word boolean,
  p_limit integer,
  p_similarity real,
  p_word_similarity real
) RETURNS TABLE (
  id text,
  name public.customers.name%TYPE,
  email public.customers.email%TYPE,
  phone public.customers.phone%TYPE
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp SET plan_cache_mode = force_custom_plan
  AS $$
  #variable_conflict use_column
  BEGIN
    IF cardinality(public.app_store_ids()) = 0 THEN
      RAISE EXCEPTION 'SEARCH_CONTEXT_REQUIRED' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT c.id, c.name, c.email, c.phone
    FROM public.customers c
    WHERE c.store_id = ANY ((SELECT public.app_store_ids())::text[])
      AND c.erased_at IS NULL
      AND c.merged_into_id IS NULL
      AND (
        c.name_search LIKE p_contains ESCAPE '\'
        OR c.email ILIKE p_typed ESCAPE '\'
        OR (c.name_search % p_folded AND similarity(c.name_search, p_folded) > p_similarity)
        OR (
          p_by_word
          AND p_folded <% c.name_search
          AND word_similarity(p_folded, c.name_search) >= p_word_similarity
        )
        OR (p_by_phone AND c.phone_normalized LIKE p_phone_like ESCAPE '\')
      )
    ORDER BY
      CASE
        WHEN c.name_search = p_folded THEN 0
        WHEN c.name_search LIKE p_starts_with ESCAPE '\' THEN 1
        WHEN c.name_search LIKE p_contains ESCAPE '\' THEN 2
        ELSE 3
      END,
      similarity(c.name_search, p_folded) DESC,
      c.name_search, c.id
    LIMIT p_limit + 1;
  END
  $$;

-- Orders by number (a part of it) and by who they are for. `p_by_customer` false: the name and the phone of the customer are not even
-- compared (a plugin whose key lacks customers:read).
CREATE FUNCTION public.rls_search_orders(
  p_folded text,
  p_contains text,
  p_starts_with text,
  p_phone_like text,
  p_by_customer boolean,
  p_by_phone boolean,
  p_limit integer
) RETURNS TABLE (
  id text,
  order_number public.orders.order_number%TYPE,
  status public.orders.status%TYPE,
  total_cents public.orders.total_cents%TYPE,
  currency public.orders.currency%TYPE,
  created_at public.orders.created_at%TYPE,
  customer_id text,
  customer_name public.customers.name%TYPE
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp SET plan_cache_mode = force_custom_plan
  AS $$
  #variable_conflict use_column
  BEGIN
    IF cardinality(public.app_store_ids()) = 0 THEN
      RAISE EXCEPTION 'SEARCH_CONTEXT_REQUIRED' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT
      o.id, o.order_number, o.status, o.total_cents, o.currency, o.created_at,
      cust.id,
      CASE WHEN p_by_customer AND cust.erased_at IS NULL THEN cust.name END
    FROM public.orders o
    JOIN public.customers cust ON cust.id = o.customer_id AND cust.store_id = o.store_id
    WHERE o.store_id = ANY ((SELECT public.app_store_ids())::text[])
      AND (
        o.order_number ILIKE p_contains ESCAPE '\'
        OR (p_by_customer AND cust.erased_at IS NULL AND cust.name_search LIKE p_contains ESCAPE '\')
        OR (p_by_phone AND cust.erased_at IS NULL AND cust.phone_normalized LIKE p_phone_like ESCAPE '\')
      )
    ORDER BY
      CASE
        WHEN lower(o.order_number) = p_folded THEN 0
        WHEN o.order_number ILIKE p_starts_with ESCAPE '\' THEN 1
        ELSE 2
      END,
      o.created_at DESC, o.id DESC
    LIMIT p_limit + 1;
  END
  $$;

REVOKE ALL ON FUNCTION
  public.rls_search_messages(text, integer, integer, text, boolean, boolean, boolean, boolean, text[], text, text, text, text),
  public.rls_search_messages_typed(text, text, integer, text, boolean, boolean, boolean, boolean, text[], text, text, text, text),
  public.rls_search_customers(text, text, text, text, text, boolean, boolean, integer, real, real),
  public.rls_search_orders(text, text, text, text, boolean, boolean, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  public.rls_search_messages(text, integer, integer, text, boolean, boolean, boolean, boolean, text[], text, text, text, text),
  public.rls_search_messages_typed(text, text, integer, text, boolean, boolean, boolean, boolean, text[], text, text, text, text),
  public.rls_search_customers(text, text, text, text, text, boolean, boolean, integer, real, real),
  public.rls_search_orders(text, text, text, text, boolean, boolean, integer)
  TO platform_app;
