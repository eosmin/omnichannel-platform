BEGIN;

-- Safe to run twice. What this migration added is derived data (a generated column and indexes): dropping it loses
-- nothing, the search falls back to what it was before. The extension is left in place: it holds no data, and a
-- database that had it before this migration would otherwise lose it.
DROP INDEX IF EXISTS idx_messages_search_unaccent;
DROP INDEX IF EXISTS idx_orders_order_number_trgm;
DROP INDEX IF EXISTS idx_customers_phone_normalized_trgm;
DROP INDEX IF EXISTS idx_customers_email_trgm;
DROP INDEX IF EXISTS idx_customers_name_search_trgm;
CREATE INDEX IF NOT EXISTS idx_customers_name_trgm ON customers USING GIN (name gin_trgm_ops);
ALTER TABLE customers DROP COLUMN IF EXISTS name_search;
DROP FUNCTION IF EXISTS public.immutable_unaccent(text);

COMMIT;
