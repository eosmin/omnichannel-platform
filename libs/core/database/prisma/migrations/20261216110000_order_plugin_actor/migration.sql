-- A plugin as the actor of the writes of an order (Step 5.6, PR E3b). The columns that say who created, confirmed, cancelled or
-- decided the price of an order held the id of a person, and a plugin has no user. Each gets a column for the plugin beside it, so
-- that the one that did it is never written as somebody else (the contract of PR M1c: a person or a plugin, never both). They are
-- nullable with no default (added without rewriting the table), have no foreign key on purpose (it would scan `orders` to be added
-- and again to delete a plugin; the id comes from the installation of the key, like `messages.author_plugin_id`) and are null for
-- every row that exists.
ALTER TABLE "orders" ADD COLUMN "created_by_plugin_id" TEXT;
ALTER TABLE "orders" ADD COLUMN "confirmed_by_plugin_id" TEXT;
ALTER TABLE "orders" ADD COLUMN "cancelled_by_plugin_id" TEXT;
ALTER TABLE "orders" ADD COLUMN "price_approval_requested_by_plugin_id" TEXT;
ALTER TABLE "orders" ADD COLUMN "price_approved_by_plugin_id" TEXT;
-- The movements of stock an order makes (reserve, release, issue, return) say who did it; null person and null plugin is the system
ALTER TABLE "inventory_movements" ADD COLUMN "created_by_plugin_id" TEXT;
-- The member who pressed "send" on a message of an order, or the plugin that did
ALTER TABLE "order_message_dispatches" ADD COLUMN "requested_by_plugin_id" TEXT;

-- An order is created by a person or by a plugin: the person's column stops being required (a metadata change, no rewrite) and the
-- check below says that one of the two is always there
ALTER TABLE "orders" ALTER COLUMN "created_by" DROP NOT NULL;

-- Added NOT VALID and NOT validated here: it is enforced for every new write at once, and a scan of `orders` under the lock a
-- migration holds (one transaction) is the outage NOT VALID avoids. Every row that exists has a person in `created_by` and a null in
-- the new columns, so none can break it; `VALIDATE CONSTRAINT` can be run by hand, outside a transaction, to mark them valid.
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_actor_check"
  CHECK (("created_by" IS NULL) <> ("created_by_plugin_id" IS NULL)) NOT VALID;
ALTER TABLE "orders" ADD CONSTRAINT "orders_confirmed_actor_check"
  CHECK ("confirmed_by" IS NULL OR "confirmed_by_plugin_id" IS NULL) NOT VALID;
ALTER TABLE "orders" ADD CONSTRAINT "orders_cancelled_actor_check"
  CHECK ("cancelled_by" IS NULL OR "cancelled_by_plugin_id" IS NULL) NOT VALID;
ALTER TABLE "orders" ADD CONSTRAINT "orders_price_requested_actor_check"
  CHECK ("price_approval_requested_by" IS NULL OR "price_approval_requested_by_plugin_id" IS NULL) NOT VALID;
ALTER TABLE "orders" ADD CONSTRAINT "orders_price_approved_actor_check"
  CHECK ("price_approved_by" IS NULL OR "price_approved_by_plugin_id" IS NULL) NOT VALID;
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_actor_check"
  CHECK ("created_by" IS NULL OR "created_by_plugin_id" IS NULL) NOT VALID;
ALTER TABLE "order_message_dispatches" ADD CONSTRAINT "order_message_dispatches_actor_check"
  CHECK ("requested_by" IS NULL OR "requested_by_plugin_id" IS NULL) NOT VALID;
