-- Rolls back 20261215130000_finance_tax. DESTRUCTIVE: the tax rates (with the default the setup seeded), the tax treatment and
-- rate of every product, the tax settings of the books (rounding and shipping) and the tax snapshot of every order and order line
-- are DROPPED with their values (the totals of the orders stay: they are their own columns, and an order whose prices excluded
-- tax keeps the total that included it). Take a copy of the tables first if the snapshots matter. Run it before the code that
-- reads these columns is brought back. Safe to run twice.
BEGIN;

ALTER TABLE IF EXISTS "journal_lines" DROP CONSTRAINT IF EXISTS "journal_lines_organization_id_tax_rate_id_fkey";

DROP TRIGGER IF EXISTS trg_products_tax_rate_organization ON products;
DROP FUNCTION IF EXISTS check_product_tax_rate_organization();

ALTER TABLE IF EXISTS "order_items"
  DROP CONSTRAINT IF EXISTS "order_items_tax_treatment_check",
  DROP CONSTRAINT IF EXISTS "order_items_tax_snapshot_check",
  DROP COLUMN IF EXISTS "tax_treatment",
  DROP COLUMN IF EXISTS "tax_rate_bps",
  DROP COLUMN IF EXISTS "tax_cents";

ALTER TABLE IF EXISTS "orders"
  DROP CONSTRAINT IF EXISTS "orders_tax_snapshot_check",
  DROP CONSTRAINT IF EXISTS "orders_tax_cents_check",
  DROP CONSTRAINT IF EXISTS "orders_shipping_tax_rate_check",
  DROP COLUMN IF EXISTS "tax_cents",
  DROP COLUMN IF EXISTS "prices_include_tax",
  DROP COLUMN IF EXISTS "shipping_tax_rate_bps";

ALTER TABLE IF EXISTS "products"
  DROP CONSTRAINT IF EXISTS "products_tax_treatment_check",
  DROP CONSTRAINT IF EXISTS "products_tax_rate_taxed_check",
  DROP CONSTRAINT IF EXISTS "products_tax_rate_id_fkey",
  DROP COLUMN IF EXISTS "tax_treatment",
  DROP COLUMN IF EXISTS "tax_rate_id";

DROP TABLE IF EXISTS "tax_rates";

ALTER TABLE IF EXISTS "finance_settings"
  DROP CONSTRAINT IF EXISTS "finance_settings_tax_rounding_check",
  DROP COLUMN IF EXISTS "tax_rounding",
  DROP COLUMN IF EXISTS "shipping_taxed";

COMMIT;
