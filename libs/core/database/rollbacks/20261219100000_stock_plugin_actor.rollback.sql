BEGIN;

-- Safe to run twice. What is lost: which plugin made, sent or applied a transfer or a count. The transfers and counts a plugin made
-- stay, with `created_by`, and `dispatched_by` or `applied_by` when it set them, = 'system' (the column is plain text, no foreign key, and 'system' is what the other author columns of
-- the schema hold for the platform), because the column is required again. The checks go first: they are enforced on every UPDATE
-- (NOT VALID only skips the rows that exist), and the updates below leave both columns set for a moment.
ALTER TABLE "stock_transfers" DROP CONSTRAINT IF EXISTS "stock_transfers_created_actor_check";
ALTER TABLE "stock_transfers" DROP CONSTRAINT IF EXISTS "stock_transfers_dispatched_actor_check";
ALTER TABLE "stock_counts" DROP CONSTRAINT IF EXISTS "stock_counts_created_actor_check";
ALTER TABLE "stock_counts" DROP CONSTRAINT IF EXISTS "stock_counts_applied_actor_check";
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'stock_transfers' AND column_name = 'created_by_plugin_id'
  ) THEN
    UPDATE "stock_transfers" SET "created_by" = 'system' WHERE "created_by" IS NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'stock_counts' AND column_name = 'created_by_plugin_id'
  ) THEN
    UPDATE "stock_counts" SET "created_by" = 'system' WHERE "created_by" IS NULL;
  END IF;
END
$$;
-- The two checks that name a person go back as they were: what a plugin sent or applied is the platform's again, so that they hold
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'stock_transfers' AND column_name = 'dispatched_by_plugin_id'
  ) THEN
    UPDATE "stock_transfers" SET "dispatched_by" = 'system'
      WHERE "dispatched_by" IS NULL AND "dispatched_by_plugin_id" IS NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'stock_counts' AND column_name = 'applied_by_plugin_id'
  ) THEN
    UPDATE "stock_counts" SET "applied_by" = 'system'
      WHERE "applied_by" IS NULL AND "applied_by_plugin_id" IS NOT NULL;
  END IF;
END
$$;
ALTER TABLE "stock_transfers" DROP CONSTRAINT IF EXISTS "chk_stock_transfers_dispatch";
ALTER TABLE "stock_transfers" ADD CONSTRAINT "chk_stock_transfers_dispatch" CHECK (
  CASE status
    WHEN 'draft' THEN dispatched_at IS NULL AND dispatched_by IS NULL
    WHEN 'in_transit' THEN dispatched_at IS NOT NULL AND dispatched_by IS NOT NULL
    WHEN 'received' THEN dispatched_at IS NOT NULL AND dispatched_by IS NOT NULL
    ELSE TRUE
  END
);
ALTER TABLE "stock_counts" DROP CONSTRAINT IF EXISTS "chk_stock_counts_applied_pair";
ALTER TABLE "stock_counts" ADD CONSTRAINT "chk_stock_counts_applied_pair" CHECK ((applied_at IS NULL) = (applied_by IS NULL));
ALTER TABLE "stock_transfers" ALTER COLUMN "created_by" SET NOT NULL;
ALTER TABLE "stock_counts" ALTER COLUMN "created_by" SET NOT NULL;

ALTER TABLE "stock_transfers" DROP COLUMN IF EXISTS "created_by_plugin_id";
ALTER TABLE "stock_transfers" DROP COLUMN IF EXISTS "dispatched_by_plugin_id";
ALTER TABLE "stock_counts" DROP COLUMN IF EXISTS "created_by_plugin_id";
ALTER TABLE "stock_counts" DROP COLUMN IF EXISTS "applied_by_plugin_id";

COMMIT;
