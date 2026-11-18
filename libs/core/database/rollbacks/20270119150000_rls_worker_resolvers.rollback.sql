-- Rollback of 20270119150000_rls_worker_resolvers: the worker goes back to reading these rows directly (it still skips row security).
DROP FUNCTION IF EXISTS rls_resolve_channel_connection(text, text);
DROP FUNCTION IF EXISTS rls_store_of_scheduled_report(text);
DROP FUNCTION IF EXISTS rls_store_of_export(text);
DROP FUNCTION IF EXISTS rls_store_of_media(text);
