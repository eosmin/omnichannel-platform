-- Rolls back 20270119100000_rls_foundation: removes the RLS tools. It fails, and changes nothing, while any table still has a
-- policy that calls app_store_ids() or app_organization_ids(): roll back the migrations of the groups of tables first (each one
-- calls rls_drop_policy for its tables), newest first. Safe to run twice.
BEGIN;

DROP VIEW IF EXISTS rls_status;
DROP FUNCTION IF EXISTS rls_set_enforcement(boolean, text[]);
DROP FUNCTION IF EXISTS rls_drop_policy(regclass);
DROP FUNCTION IF EXISTS rls_apply_policy(regclass, text);
DROP FUNCTION IF EXISTS app_organization_ids();
DROP FUNCTION IF EXISTS app_store_ids();

COMMIT;
