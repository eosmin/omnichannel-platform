-- Step 7.2-C: the data that hangs from an erased customer (the text of its messages, its files, the names in its notifications) is cleared by a
-- job and by a daily sweep. This column says when it was all cleared; a customer that is erased and has none is what the sweep takes. No table is
-- created, so no policy: the table keeps the ones it has.
-- Rollback: rollbacks/20270124200000_erased_customer_data_purge.rollback.sql
ALTER TABLE "customers" ADD COLUMN "erased_data_purged_at" TIMESTAMP(3);

-- Few rows (the customers erased and not yet cleared): the sweep reads exactly them
CREATE INDEX "ix_customers_erased_pending" ON "customers" ("store_id")
  WHERE "erased_at" IS NOT NULL AND "erased_data_purged_at" IS NULL;
