BEGIN;

-- Safe to run twice. What is lost: which plugin created, confirmed, cancelled or decided the price of an order, moved stock, or asked
-- for a message to be sent. The orders a plugin created stay, with `created_by` = 'system' (the column is plain text, no foreign
-- key, and 'system' is what the other author columns of the schema hold for the platform), because the column is required again.
-- The check goes first: it is enforced on every UPDATE (NOT VALID only skips the rows that exist), and the update below leaves both
-- columns set for a moment
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_created_actor_check";
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'orders' AND column_name = 'created_by_plugin_id'
  ) THEN
    UPDATE "orders" SET "created_by" = 'system' WHERE "created_by" IS NULL;
  END IF;
END
$$;

ALTER TABLE "order_message_dispatches" DROP CONSTRAINT IF EXISTS "order_message_dispatches_actor_check";
ALTER TABLE "inventory_movements" DROP CONSTRAINT IF EXISTS "inventory_movements_actor_check";
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_price_approved_actor_check";
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_price_requested_actor_check";
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_cancelled_actor_check";
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_confirmed_actor_check";
ALTER TABLE "orders" ALTER COLUMN "created_by" SET NOT NULL;

ALTER TABLE "order_message_dispatches" DROP COLUMN IF EXISTS "requested_by_plugin_id";
ALTER TABLE "inventory_movements" DROP COLUMN IF EXISTS "created_by_plugin_id";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "price_approved_by_plugin_id";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "price_approval_requested_by_plugin_id";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "cancelled_by_plugin_id";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "confirmed_by_plugin_id";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "created_by_plugin_id";

COMMIT;
