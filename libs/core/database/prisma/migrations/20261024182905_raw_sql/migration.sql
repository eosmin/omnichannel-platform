-- What Prisma cannot express: extensions, generated tsvector columns, partial indexes,
-- conditional uniques, CHECK constraints, and the database roles with their grants.

-- Extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Full-text search vectors (generated columns, not declared in the Prisma schema)
ALTER TABLE messages
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('spanish', coalesce(content, ''))) STORED;
CREATE INDEX idx_messages_search ON messages USING GIN (search_vector);

ALTER TABLE customers
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('spanish', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple',  coalesce(email, '')), 'B') ||
    setweight(to_tsvector('simple',  coalesce(phone_normalized, '')), 'B')
  ) STORED;
CREATE INDEX idx_customers_search ON customers USING GIN (search_vector);

ALTER TABLE products
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('spanish', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple',  coalesce(sku, '')), 'B') ||
    setweight(to_tsvector('spanish', coalesce(description, '')), 'C')
  ) STORED;
CREATE INDEX idx_products_search ON products USING GIN (search_vector);

-- Trigram indexes for typo-tolerant matching
CREATE INDEX idx_customers_name_trgm ON customers USING GIN (name gin_trgm_ops);
CREATE INDEX idx_products_name_trgm  ON products  USING GIN (name gin_trgm_ops);

-- Partial indexes Prisma cannot declare
CREATE INDEX idx_conversations_active_inbox
  ON conversations (store_id, assigned_to, last_message_at DESC)
  WHERE status IN ('OPEN', 'PENDING');

CREATE INDEX idx_notifications_unread
  ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX idx_customers_phone
  ON customers (store_id, phone_normalized)
  WHERE phone_normalized IS NOT NULL;

-- Uniqueness with NULLs / conditional uniqueness
CREATE UNIQUE INDEX uq_roles_system_name ON roles (name) WHERE store_id IS NULL;
CREATE UNIQUE INDEX uq_roles_store_name  ON roles (store_id, name) WHERE store_id IS NOT NULL;
DROP INDEX IF EXISTS invitations_store_id_email_status_key;
CREATE UNIQUE INDEX uq_invitations_pending ON invitations (store_id, email) WHERE status = 'PENDING';

-- Invariants
ALTER TABLE conversations
  ADD CONSTRAINT chk_csat_range CHECK (csat_score IS NULL OR csat_score BETWEEN 1 AND 5);

-- Database roles (decision D16). Created without LOGIN: scripts/set-db-role-passwords.ts gives
-- them LOGIN and their passwords after the migrations, so no password is ever in a migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    CREATE ROLE platform_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_worker') THEN
    CREATE ROLE platform_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO platform_app, platform_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_app, platform_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO platform_app, platform_worker;
-- Tables and sequences created by later migrations are covered too
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_app, platform_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO platform_app, platform_worker;

-- Only the owner runs migrations
REVOKE ALL ON TABLE _prisma_migrations FROM platform_app, platform_worker;

-- The audit log is append-only for the api (TDD_05 §9.3); the worker keeps DELETE for the retention export
REVOKE UPDATE, DELETE ON TABLE audit_logs FROM platform_app;
