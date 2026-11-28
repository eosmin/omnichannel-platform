-- Finance, exchange with a difference (HC-138): how the books and the fiscal documents read the credit of a replacement order.
--
-- 'net': the credit is a discount of the replacement, which is recognized for what the customer pays (the way every exchange was booked until now).
-- 'gross': the replacement is a sale at the full price; the credit of the return it uses is consumed from the customer's advances and the
-- customer pays the difference (criterion of the accountant). The books, the VAT report, the margin and the fiscal documents recompute the gross
-- figures from what the order stored (rate of each line, price mode, rounding), so no amount is kept twice.
--
-- NO backfill: null means 'net', which is what every order that exists was booked and documented with. The entries and the accepted documents
-- are immutable, so an order made before this column must keep being read as it was posted. Only a replacement created from now on is 'gross'.
-- The table is already tenant-scoped and under row-level security: a column adds no policy of its own.
-- Rollback: rollbacks/20270221100000_orders_exchange_credit_mode.rollback.sql
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "exchange_credit_mode" TEXT;

-- Only a replacement of an exchange has a mode, and it is one of the two
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_exchange_credit_mode_check";
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_exchange_credit_mode_check" CHECK (
    "exchange_credit_mode" IS NULL
    OR ("exchange_of_order_id" IS NOT NULL AND "exchange_credit_mode" IN ('net', 'gross'))
  );
