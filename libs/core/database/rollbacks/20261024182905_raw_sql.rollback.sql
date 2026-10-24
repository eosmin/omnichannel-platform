-- Rolls back 20261024182905_raw_sql. The roles are dropped last, after their privileges.
ALTER TABLE IF EXISTS conversations DROP CONSTRAINT IF EXISTS chk_csat_range;

DROP INDEX IF EXISTS uq_invitations_pending;
DO $$
BEGIN
  IF to_regclass('public.invitations') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS invitations_store_id_email_status_key ON invitations (store_id, email, status);
  END IF;
END
$$;
DROP INDEX IF EXISTS uq_roles_store_name;
DROP INDEX IF EXISTS uq_roles_system_name;

DROP INDEX IF EXISTS idx_customers_phone;
DROP INDEX IF EXISTS idx_notifications_unread;
DROP INDEX IF EXISTS idx_conversations_active_inbox;
DROP INDEX IF EXISTS idx_products_name_trgm;
DROP INDEX IF EXISTS idx_customers_name_trgm;

DROP INDEX IF EXISTS idx_products_search;
ALTER TABLE IF EXISTS products DROP COLUMN IF EXISTS search_vector;
DROP INDEX IF EXISTS idx_customers_search;
ALTER TABLE IF EXISTS customers DROP COLUMN IF EXISTS search_vector;
DROP INDEX IF EXISTS idx_messages_search;
ALTER TABLE IF EXISTS messages DROP COLUMN IF EXISTS search_vector;

-- pg_trgm is left installed: other objects may depend on it

-- Roles belong to the whole cluster: while another database still grants them privileges they
-- cannot be dropped, and they are left in place with a notice. They carry no data.
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['platform_app', 'platform_worker'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      BEGIN
        EXECUTE format('DROP OWNED BY %I', role_name);
        EXECUTE format('DROP ROLE %I', role_name);
      EXCEPTION WHEN dependent_objects_still_exist THEN
        RAISE NOTICE 'role % kept: another database still depends on it', role_name;
      END;
    END IF;
  END LOOP;
END
$$;

-- Verification query: must return 0
SELECT COUNT(*) FROM information_schema.columns
WHERE table_name IN ('messages', 'customers', 'products') AND column_name = 'search_vector';
