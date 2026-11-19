-- Row-Level Security, search of products and variants (plan B, see rls_search_functions). With the policies enforced, Postgres does not
-- push a trigram operator (ILIKE) that is not LEAKPROOF below the row policy, so the autocomplete of products and the text filter of
-- the stock levels stopped using the GIN indexes on products.name/sku and product_variants.name/sku. These two functions are
-- SECURITY DEFINER (they run as the owner of the tables, whose <table>_owner policy lets every row through, so the planner is free to
-- use the index), read-only, and they filter by THEMSELVES what the policy would: the store is the one of the transaction context
-- (app_store_ids()), never an argument, and a call with no store in the context raises SEARCH_CONTEXT_REQUIRED (42501) instead of
-- answering empty. The variants are only ever read through the products of the store. The statements are planned with the real
-- values of each call (SET plan_cache_mode = force_custom_plan). The text arrives already escaped for LIKE by the caller (the
-- patterns), and the search_path ends in pg_temp (pnpm validate:definer). Only the role of the api may call them.

-- The autocomplete of products (ProductSearchService): the products of the store whose name or sku, or the name or sku of a variant,
-- contain the text, best match first, each with the variant that is the reason it is in the answer.
CREATE FUNCTION public.rls_search_products(
  p_text text,
  p_starts text,
  p_contains text,
  p_archived boolean,
  p_limit integer
) RETURNS TABLE (
  id text,
  name text,
  sku text,
  price_cents public.products.price_cents%TYPE,
  image_media_id text,
  active boolean,
  variant_id text,
  variant_name text,
  variant_sku text,
  variant_price_cents public.product_variants.price_cents%TYPE
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp SET plan_cache_mode = force_custom_plan SET standard_conforming_strings = on
  AS $$
  #variable_conflict use_column
  BEGIN
    IF cardinality(public.app_store_ids()) = 0 THEN
      RAISE EXCEPTION 'SEARCH_CONTEXT_REQUIRED' USING ERRCODE = '42501';
    END IF;
    -- The size of the answer is bounded here, not only by the caller: NULL would be LIMIT NULL, which is no limit
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
      RAISE EXCEPTION 'SEARCH_LIMIT_INVALID' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY
    WITH cand AS (
      -- The products that match, by name or sku, or through a variant: two statements joined by UNION so that each one can be an
      -- index condition (an OR with an EXISTS cannot: the planner would read the whole store)
      SELECT p.id
      FROM public.products p
      WHERE p.store_id = ANY ((SELECT public.app_store_ids())::text[])
        AND (p_archived OR p.active)
        AND (p.name ILIKE p_contains ESCAPE '\' OR p.sku ILIKE p_contains ESCAPE '\')
      UNION
      SELECT v.product_id
      FROM public.product_variants v
      JOIN public.products p ON p.id = v.product_id
      WHERE p.store_id = ANY ((SELECT public.app_store_ids())::text[])
        AND (p_archived OR p.active)
        AND (p_archived OR v.active)
        AND (v.name ILIKE p_contains ESCAPE '\' OR v.sku ILIKE p_contains ESCAPE '\')
    )
    SELECT
      h.id, h.name, h.sku, h.price_cents, h.image_media_id, h.active,
      mv.id, mv.name, mv.sku, mv.price_cents
    FROM (
      SELECT
        p.id, p.name, p.sku, p.price_cents, p.image_media_id, p.active,
        CASE
          WHEN lower(p.sku) = lower(p_text) THEN 0
          WHEN EXISTS (
            SELECT 1 FROM public.product_variants v
            WHERE v.product_id = p.id AND lower(v.sku) = lower(p_text) AND (p_archived OR v.active)
          ) THEN 0
          WHEN p.name ILIKE p_starts ESCAPE '\' OR p.sku ILIKE p_starts ESCAPE '\' THEN 1
          WHEN NOT (p.name ILIKE p_contains ESCAPE '\' OR coalesce(p.sku ILIKE p_contains ESCAPE '\', false))
            AND EXISTS (
            SELECT 1 FROM public.product_variants v
            WHERE v.product_id = p.id
              AND (v.name ILIKE p_starts ESCAPE '\' OR v.sku ILIKE p_starts ESCAPE '\')
              AND (p_archived OR v.active)
          ) THEN 1
          ELSE 2
        END AS rank
      FROM public.products p
      WHERE p.id IN (SELECT cand.id FROM cand)
      ORDER BY rank, p.name, p.id
      LIMIT p_limit
    ) h
    LEFT JOIN LATERAL (
      SELECT v.id, v.name, v.sku, v.price_cents
      FROM public.product_variants v
      WHERE v.product_id = h.id
        -- A product that matched by itself (its name or its sku) is shown as itself: the variant is only named when it is the
        -- reason the product is in the answer, or when its sku is exactly the text
        AND (
          coalesce(lower(v.sku) = lower(p_text), false)
          OR NOT (
            h.name ILIKE p_contains ESCAPE '\'
            OR coalesce(h.sku ILIKE p_contains ESCAPE '\', false)
          )
        )
        AND (v.name ILIKE p_contains ESCAPE '\' OR v.sku ILIKE p_contains ESCAPE '\')
        AND (p_archived OR v.active)
      ORDER BY coalesce(lower(v.sku) = lower(p_text), false) DESC, v.name, v.id
      LIMIT 1
    ) mv ON TRUE
    ORDER BY h.rank, h.name, h.id;
  END
  $$;

-- The products and the variants of the store whose name or sku contain the text (the filter of the stock levels): `kind` is the
-- word the caller gave for each (p_product_kind, p_variant_kind). At most p_limit of each kind are answered; the caller asks for one more than it accepts and refuses a
-- search that is too wide, it never works with a truncated answer.
CREATE FUNCTION public.rls_search_product_matches(
  p_contains text,
  p_limit integer,
  p_product_kind text,
  p_variant_kind text
) RETURNS TABLE (
  kind text,
  id text
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp SET plan_cache_mode = force_custom_plan SET standard_conforming_strings = on
  AS $$
  #variable_conflict use_column
  BEGIN
    IF cardinality(public.app_store_ids()) = 0 THEN
      RAISE EXCEPTION 'SEARCH_CONTEXT_REQUIRED' USING ERRCODE = '42501';
    END IF;
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10001 THEN
      RAISE EXCEPTION 'SEARCH_LIMIT_INVALID' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY
    (
      SELECT p_product_kind, p.id
      FROM public.products p
      WHERE p.store_id = ANY ((SELECT public.app_store_ids())::text[])
        AND (p.name ILIKE p_contains ESCAPE '\' OR p.sku ILIKE p_contains ESCAPE '\')
      LIMIT p_limit
    )
    UNION ALL
    (
      SELECT p_variant_kind, v.id
      FROM public.product_variants v
      JOIN public.products p ON p.id = v.product_id
      WHERE p.store_id = ANY ((SELECT public.app_store_ids())::text[])
        AND (v.name ILIKE p_contains ESCAPE '\' OR v.sku ILIKE p_contains ESCAPE '\')
      LIMIT p_limit
    );
  END
  $$;

REVOKE ALL ON FUNCTION public.rls_search_products(text, text, text, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rls_search_product_matches(text, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rls_search_products(text, text, text, boolean, integer) TO platform_app;
GRANT EXECUTE ON FUNCTION public.rls_search_product_matches(text, integer, text, text) TO platform_app;
