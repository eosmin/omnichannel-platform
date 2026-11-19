-- Rolls back 20270122600000_rls_search_order_customers. ORDER: deploy the previous build of the api and of the worker FIRST: the current
-- ones call the function (the orders list and its export, when there is a search text that is not an order number) and would fail with
-- 'function does not exist' the moment it is dropped. Nothing else changed in that migration, so no data is touched. Safe to run twice.
BEGIN;

DROP FUNCTION IF EXISTS public.rls_search_order_customers(text, text, text, integer);
-- The index of the name that the migration created again (search_unaccent had dropped it)
DROP INDEX IF EXISTS public.idx_customers_name_trgm;

COMMIT;
