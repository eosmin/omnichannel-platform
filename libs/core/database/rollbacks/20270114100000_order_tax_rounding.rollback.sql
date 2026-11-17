-- Rolls back 20270114100000_order_tax_rounding: drops the rounding that each order kept with its tax snapshot. An order that is priced
-- again afterwards takes the rounding of the books of that day, as before the migration. Safe to run twice.
BEGIN;

ALTER TABLE IF EXISTS "orders" DROP CONSTRAINT IF EXISTS "orders_tax_rounding_check";
ALTER TABLE IF EXISTS "orders" DROP COLUMN IF EXISTS "tax_rounding";

COMMIT;
