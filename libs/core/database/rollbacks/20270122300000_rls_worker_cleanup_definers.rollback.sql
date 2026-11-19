-- Rollback of 20270122300000_rls_worker_cleanup_definers: the code that calls these functions (AuditColdExporter, OrphanMediaCleaner)
-- goes first (revert the commit), then this runs. Idempotent.
DROP FUNCTION IF EXISTS public.rls_avatar_media_keys(text[]);
DROP FUNCTION IF EXISTS public.rls_clear_orphan_avatar(text, timestamp, text[]);
DROP FUNCTION IF EXISTS public.rls_list_orphan_avatars(timestamp, text[], text[], text, integer);
DROP FUNCTION IF EXISTS public.rls_list_avatar_media(text[], timestamp, timestamp, text[], text, integer);
DROP FUNCTION IF EXISTS public.rls_audit_logs_for_cold_export(timestamp, timestamp, timestamp, text, integer);
DROP FUNCTION IF EXISTS public.rls_audit_count_between(timestamp, timestamp);
DROP FUNCTION IF EXISTS public.rls_audit_oldest_before(timestamp);
