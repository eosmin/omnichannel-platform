-- Step 4.1 (autocomplete of products): the search matches a text inside the sku of a product and inside the name
-- and the sku of a variant with ILIKE '%text%', which only a trigram index can serve. The name of a product already
-- has one (idx_products_name_trgm, 20261024182905_raw_sql, which also creates pg_trgm; this migration does not touch
-- the extension). GIN indexes Prisma cannot declare, so raw SQL like theirs.
CREATE INDEX IF NOT EXISTS idx_products_sku_trgm ON products USING GIN (sku gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_product_variants_name_trgm ON product_variants USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_product_variants_sku_trgm ON product_variants USING GIN (sku gin_trgm_ops);
-- A plain CREATE INDEX blocks writes to the table while it builds (Prisma runs a migration in a transaction, where
-- CONCURRENTLY is not allowed): accepted, the catalog tables are small and nobody writes them during a deploy.
