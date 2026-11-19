-- Rollback of 20270122800000_rls_plugin_key_plugin_status: drops the lookup. Idempotent. The guard of the previous version reads the
-- plugin with a nested select, so deploy the code of that version first.
DROP FUNCTION IF EXISTS public.lookup_plugin_status_of_key(text);
