-- Rollback of 20270121850000_rls_drop_store_of_resolvers: recreates the three functions as 20270121100000_rls_worker_resolvers made them.
-- Nothing calls them after the rollback of the code that stopped needing them, so deploy the old code first.
CREATE OR REPLACE FUNCTION rls_store_of_media(p_id text) RETURNS TABLE (found boolean, store_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT true, m.store_id FROM public.media m WHERE m.id = p_id
  $$;

CREATE OR REPLACE FUNCTION rls_store_of_export(p_id text) RETURNS TABLE (found boolean, store_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT true, e.store_id FROM public.exports e WHERE e.id = p_id
  $$;

CREATE OR REPLACE FUNCTION rls_store_of_scheduled_report(p_id text) RETURNS TABLE (found boolean, store_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT true, r.store_id FROM public.scheduled_reports r WHERE r.id = p_id
  $$;

REVOKE ALL ON FUNCTION rls_store_of_media(text), rls_store_of_export(text), rls_store_of_scheduled_report(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rls_store_of_media(text), rls_store_of_export(text), rls_store_of_scheduled_report(text) TO platform_worker;
