-- Rollback of 20270121600000_rls_search_functions: the search reads the tables directly again (the service of that release does).
DROP FUNCTION IF EXISTS public.rls_search_orders(text, text, text, text, boolean, boolean, integer);
DROP FUNCTION IF EXISTS public.rls_search_customers(text, text, text, text, text, boolean, boolean, integer, real, real);
DROP FUNCTION IF EXISTS public.rls_search_messages_typed(text, text, integer, text, boolean, boolean, boolean, boolean, text[], text, text, text, text);
DROP FUNCTION IF EXISTS public.rls_search_messages(text, integer, integer, text, boolean, boolean, boolean, boolean, text[], text, text, text, text);
