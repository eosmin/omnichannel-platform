-- A plugin as the actor of the writes of transfers and counts (Step 5.6, PR E4b-2). The columns that say who made, sent or applied a
-- transfer or a count held the id of a person, and a plugin has no user. Each gets a column for the plugin beside it, so that the one
-- that did it is never written as somebody else (the contract of PR M1c: a person or a plugin, never both). They are nullable with no
-- default (added without rewriting the table), have no foreign key on purpose (it would scan the table to be added and again to
-- delete a plugin; the id comes from the installation of the key, like `orders.created_by_plugin_id`) and are null for every row that
-- exists. The movements of stock they write already carry `inventory_movements.created_by_plugin_id` (PR E3b).
ALTER TABLE "stock_transfers" ADD COLUMN "created_by_plugin_id" TEXT;
ALTER TABLE "stock_transfers" ADD COLUMN "dispatched_by_plugin_id" TEXT;
ALTER TABLE "stock_counts" ADD COLUMN "created_by_plugin_id" TEXT;
ALTER TABLE "stock_counts" ADD COLUMN "applied_by_plugin_id" TEXT;

-- A transfer or a count is made by a person or by a plugin: the person's column stops being required (a metadata change, no
-- rewrite) and the check says that exactly one of the two is always there
ALTER TABLE "stock_transfers" ALTER COLUMN "created_by" DROP NOT NULL;
ALTER TABLE "stock_counts" ALTER COLUMN "created_by" DROP NOT NULL;

-- Added NOT VALID and not validated here: it is enforced for every new write at once, and a scan under the lock a migration holds
-- (one transaction) is the outage NOT VALID avoids. Every row that exists has a person in `created_by` and a null in the new
-- columns, so none can break it; `VALIDATE CONSTRAINT` can be run by hand, outside a transaction (Step 7.3).
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_created_actor_check"
  CHECK (("created_by" IS NULL) <> ("created_by_plugin_id" IS NULL)) NOT VALID;
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_dispatched_actor_check"
  CHECK ("dispatched_by" IS NULL OR "dispatched_by_plugin_id" IS NULL) NOT VALID;
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_created_actor_check"
  CHECK (("created_by" IS NULL) <> ("created_by_plugin_id" IS NULL)) NOT VALID;
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_applied_actor_check"
  CHECK ("applied_by" IS NULL OR "applied_by_plugin_id" IS NULL) NOT VALID;

-- Two checks of the first migrations of these tables say that who sent a transfer and who applied a count is a PERSON: a transfer that
-- left has `dispatched_by`, and the marker of an applied count is `applied_at` and `applied_by` together. A plugin sets the column
-- beside, so both checks are replaced with the same rule that names either of the two (added NOT VALID for the reason above: every row
-- that exists satisfies the old rule, which these include).
ALTER TABLE "stock_transfers" DROP CONSTRAINT "chk_stock_transfers_dispatch";
ALTER TABLE "stock_transfers" ADD CONSTRAINT "chk_stock_transfers_dispatch" CHECK (
  CASE status
    WHEN 'draft' THEN dispatched_at IS NULL AND dispatched_by IS NULL AND dispatched_by_plugin_id IS NULL
    WHEN 'in_transit' THEN dispatched_at IS NOT NULL AND (dispatched_by IS NOT NULL OR dispatched_by_plugin_id IS NOT NULL)
    WHEN 'received' THEN dispatched_at IS NOT NULL AND (dispatched_by IS NOT NULL OR dispatched_by_plugin_id IS NOT NULL)
    ELSE TRUE
  END
) NOT VALID;
ALTER TABLE "stock_counts" DROP CONSTRAINT "chk_stock_counts_applied_pair";
ALTER TABLE "stock_counts" ADD CONSTRAINT "chk_stock_counts_applied_pair" CHECK (
  (applied_at IS NULL) = (applied_by IS NULL AND applied_by_plugin_id IS NULL)
) NOT VALID;
