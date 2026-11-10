-- Rolls back 20261120100000_product_search_trigram_indexes: drops the three trigram indexes and nothing else. The
-- pg_trgm extension stays: the customers and the name of a product depend on it, and this migration never created it.
-- Safe to run twice.
BEGIN;

DROP INDEX IF EXISTS idx_product_variants_sku_trgm;
DROP INDEX IF EXISTS idx_product_variants_name_trgm;
DROP INDEX IF EXISTS idx_products_sku_trgm;

COMMIT;
