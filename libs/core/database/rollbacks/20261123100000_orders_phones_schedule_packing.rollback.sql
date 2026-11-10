-- Rolls back 20261123100000_orders_phones_schedule_packing: drops the five columns of orders and the three indexes.
-- The recipient phones, the scheduled day, the packing notes and the payment reference and receipt written since the
-- migration are lost with them.
-- Safe to run twice.
BEGIN;

DROP INDEX IF EXISTS "order_items_variant_id_idx";
DROP INDEX IF EXISTS "order_items_product_id_idx";
DROP INDEX IF EXISTS "orders_store_id_scheduled_delivery_date_idx";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "scheduled_delivery_date";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "recipient_phones";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "packing_notes";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "payment_reference";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "payment_proof_media_id";

COMMIT;
