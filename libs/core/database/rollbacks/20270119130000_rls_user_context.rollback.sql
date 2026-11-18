-- Rolls back 20270119130000_rls_user_context. It fails, and changes nothing, while a policy still calls app_user_id(): roll back the
-- migrations of the groups of tables that use it first, newest first. Safe to run twice.
BEGIN;

DROP FUNCTION IF EXISTS app_user_id();

COMMIT;
