-- Rolls back 20261119100000_product_cost_and_optional_threshold: the CHECKs, the unique SKU and the index of the media of a product go, both cost columns are
-- DROPPED (their values are lost), and the low-stock threshold is NOT NULL with its default of 5 again: a product with
-- no threshold (no alert) gets 5, which turns an alert ON for it. Run it before the code that reads the columns is
-- brought back. The code that is brought back does not refuse to delete a product that has files (the delete
-- guard of PR A of Step 4.1 is gone with it), which leaves them with no product. Safe to run twice.
BEGIN;

ALTER TABLE "product_variants" DROP CONSTRAINT IF EXISTS chk_product_variants_cost_cents;
ALTER TABLE "product_variants" DROP CONSTRAINT IF EXISTS chk_product_variants_price_cents;
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS chk_products_low_stock_threshold;
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS chk_products_cost_cents;
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS chk_products_price_cents;

DROP INDEX IF EXISTS "media_product_id_store_id_idx";
DROP INDEX IF EXISTS "product_variants_product_id_sku_key";

ALTER TABLE "product_variants" DROP COLUMN IF EXISTS "cost_cents";
ALTER TABLE "products" DROP COLUMN IF EXISTS "cost_cents";

UPDATE "products" SET "low_stock_threshold" = 5 WHERE "low_stock_threshold" IS NULL;
ALTER TABLE "products" ALTER COLUMN "low_stock_threshold" SET DEFAULT 5;
ALTER TABLE "products" ALTER COLUMN "low_stock_threshold" SET NOT NULL;

COMMIT;
