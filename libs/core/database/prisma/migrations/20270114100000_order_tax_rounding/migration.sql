-- The tax snapshot of an order (TDD_18 §7) keeps the rounding it was made with. Until now the rounding was read from the books each time
-- the tax of an order was computed again, so sending the same items after the organization changed its rounding moved the tax and the
-- total of an order that was already quoted.
ALTER TABLE "orders" ADD COLUMN "tax_rounding" TEXT;

-- An order that carries a tax snapshot was made with a rounding nobody wrote down: the one of its books today is the best that is known,
-- and it is what such an order would have been priced with anyway. Freezing it now keeps the next change of the books from moving it.
-- Orders with no snapshot (made before the tax columns) keep null and carry no tax.
UPDATE "orders" o
SET "tax_rounding" = fs."tax_rounding"
FROM "stores" s
JOIN "finance_settings" fs ON fs."organization_id" = s."organization_id"
WHERE s."id" = o."store_id" AND o."tax_cents" IS NOT NULL;

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_tax_rounding_check" CHECK (
    "tax_rounding" IS NULL OR ("tax_cents" IS NOT NULL AND "tax_rounding" IN ('half_up', 'half_even', 'down', 'up'))
  );
