-- Accent-insensitive search (Step 5.1, TDD_08 §5). The Spanish stemmer of Postgres folds accents unevenly ("jose"
-- finds "José" and "maria" does not find "María"), so the text is folded on both sides before it is compared.
CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA public;

-- `unaccent` is only STABLE (its dictionary can change), so an index or a generated column cannot use it. This wrapper
-- pins the dictionary, which is what makes the fold usable in both. The schema is named so that the function does not
-- depend on the search_path of whoever runs the statement.
CREATE OR REPLACE FUNCTION public.immutable_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- The name as the search compares it: no accents, lower case (unaccent first: lower() follows the locale of the database,
-- and the capitals unaccent returns are plain ASCII, which every locale lowers the same way). Generated, so no writer can forget it or let it drift.
ALTER TABLE customers
  ADD COLUMN name_search text
  GENERATED ALWAYS AS (lower(immutable_unaccent(coalesce(name, '')))) STORED;

-- Trigram indexes for the substring and typo search of customers (LIKE '%text%' and the % operator)
CREATE INDEX idx_customers_name_search_trgm ON customers USING GIN (name_search gin_trgm_ops);
-- On the email itself, not on lower(email): gin_trgm_ops serves ILIKE, which is what the Prisma `insensitive` filter of
-- the customers list writes
CREATE INDEX idx_customers_email_trgm ON customers USING GIN (email gin_trgm_ops);
CREATE INDEX idx_customers_phone_normalized_trgm ON customers USING GIN (phone_normalized gin_trgm_ops);
CREATE INDEX idx_orders_order_number_trgm ON orders USING GIN (order_number gin_trgm_ops);

-- The name is compared in name_search now: the trigram index on the raw name serves nothing and costs a write
DROP INDEX IF EXISTS idx_customers_name_trgm;

-- The messages of the inbox search, folded on both sides. The expression must read exactly as the query writes it.
CREATE INDEX idx_messages_search_unaccent
  ON messages USING GIN (to_tsvector('spanish', immutable_unaccent(coalesce(content, ''))));

-- Locks: ADD COLUMN ... GENERATED STORED rewrites `customers`, and the plain CREATE INDEX statements block writes to their
-- table while they build (Prisma runs a migration in a transaction, so CONCURRENTLY is not possible). Fine for the
-- volumes of the MVP; a large `messages` table needs a maintenance window (IMPLEMENTATION_PLAN, Step 5.1, debt (e)).
