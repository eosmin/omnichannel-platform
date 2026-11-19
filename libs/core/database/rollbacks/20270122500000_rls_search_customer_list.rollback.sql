-- Rolls back 20270122500000_rls_search_customer_list. ORDER: deploy the previous build of the api and of the worker FIRST: the current
-- ones call both functions (the list of customers and its export, when there is a search text) and would fail with 'function does
-- not exist' the moment they are dropped here. Nothing else changed in that migration, so no data is touched. Safe to run twice.
BEGIN;

DROP FUNCTION IF EXISTS public.rls_count_customer_list(text, text, text);
DROP FUNCTION IF EXISTS public.rls_search_customer_list(text, text, text, boolean, text, text, integer);

COMMIT;
