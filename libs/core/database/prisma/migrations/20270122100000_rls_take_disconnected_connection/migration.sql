-- rls_take_disconnected_connection: the ONE write of the api that crosses stores. When a store connects an account (plugin, connection
-- id) that another store let go (its row is DISCONNECTED), the row stays with that store, because its conversations point at it, and gives
-- up the key (plugin, connection id) so that the new store can have it. Row security hides the row of another store from the
-- application role, so the UPDATE the api used to make finds nothing and the connect answers "account in use". This function is that
-- UPDATE and nothing else:
--   - p_store_id is the store that wants the account. It must be in the context of the transaction (the function never takes the word of
--     a parameter alone) and must have the plugin installed and active, which is what `connect` has already checked;
--   - it renames the connection id of the row of (p_plugin_id, p_connection_id) to '<id>~released~<row id>' (the name is made here, the
--     caller cannot choose it), only while the row is DISCONNECTED and only when it is of another store than p_store_id;
--   - it changes no other column than the key and updated_at (written in UTC, like the rest of the system), returns the number of rows it changed (0 or 1: the key is unique) and never a row;
--   - a context that does not hold p_store_id raises 42501 instead of answering 0; the context is read once, into a variable.
-- A row that is ACTIVE or in ERROR is never touched: the status is written in the function, not passed in (a parameter could be 'active').
-- The function trusts the context like every policy does (the application sets it from the guard, never from the body).
-- Owner: the role of the migrations. search_path ends in pg_temp. EXECUTE only for platform_app (the api; the worker never takes an account).
-- Rollback: rollbacks/20270122100000_rls_take_disconnected_connection.rollback.sql (the code that calls it goes first).
CREATE FUNCTION public.rls_take_disconnected_connection(p_store_id text, p_plugin_id text, p_connection_id text) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_stores text[] := public.app_store_ids()::text[];
    v_changed integer;
  BEGIN
    IF p_store_id IS NULL OR NOT (p_store_id = ANY (v_stores)) THEN
      RAISE EXCEPTION 'TAKE_CONTEXT_REQUIRED' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.plugin_installations i
       WHERE i.store_id = p_store_id AND i.plugin_id = p_plugin_id AND i.status = 'active'
    ) THEN
      RETURN 0;
    END IF;
    UPDATE public.channel_connections c
       SET connection_id = c.connection_id || '~released~' || c.id,
           updated_at = (pg_catalog.now() AT TIME ZONE 'UTC')
     WHERE c.plugin_id = p_plugin_id
       AND c.connection_id = p_connection_id
       AND c.status = 'disconnected'
       AND c.store_id <> p_store_id;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    RETURN v_changed;
  END
  $$;

REVOKE ALL ON FUNCTION public.rls_take_disconnected_connection(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rls_take_disconnected_connection(text, text, text) TO platform_app;
