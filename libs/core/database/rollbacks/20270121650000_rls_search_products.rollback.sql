-- Rolls back 20270121650000_rls_search_products. ORDER: deploy the previous build of the api FIRST: the current one calls both functions
-- (the autocomplete of products and the text filter of the stock levels) and would fail with 'function does not exist' the moment they
-- are dropped here. Nothing else changed in that migration, so no data is touched. Safe to run twice.
BEGIN;

DROP FUNCTION IF EXISTS public.rls_search_products(text, text, text, boolean, integer);
DROP FUNCTION IF EXISTS public.rls_search_product_matches(text, integer, text, text);

COMMIT;
