-- Step 4.1 (products API). A reference cost per unit in USD cents on the product and on its variants (null on a variant
-- = the cost of the product), a low-stock threshold that may be empty (null = no alert, TDD_16 §4.4: the column loses its
-- default of 5), a unique SKU inside a product, and CHECKs so that no amount or threshold is ever negative.
ALTER TABLE "products" ADD COLUMN "cost_cents" INTEGER;
ALTER TABLE "products" ALTER COLUMN "low_stock_threshold" DROP NOT NULL;
ALTER TABLE "products" ALTER COLUMN "low_stock_threshold" DROP DEFAULT;
ALTER TABLE "product_variants" ADD COLUMN "cost_cents" INTEGER;

CREATE UNIQUE INDEX "product_variants_product_id_sku_key" ON "product_variants"("product_id", "sku");

ALTER TABLE "products"
  ADD CONSTRAINT chk_products_price_cents CHECK (price_cents >= 0),
  ADD CONSTRAINT chk_products_cost_cents CHECK (cost_cents IS NULL OR cost_cents >= 0),
  ADD CONSTRAINT chk_products_low_stock_threshold CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0);
ALTER TABLE "product_variants"
  ADD CONSTRAINT chk_product_variants_price_cents CHECK (price_cents IS NULL OR price_cents >= 0),
  ADD CONSTRAINT chk_product_variants_cost_cents CHECK (cost_cents IS NULL OR cost_cents >= 0);

-- The pictures of a product are read (and counted before a delete) by (product, store); product_id leads because
-- the foreign key (ON DELETE SET NULL) looks the rows up by product_id alone
CREATE INDEX "media_product_id_store_id_idx" ON "media"("product_id", "store_id");
