-- Rolls back 20270124200000_erased_customer_data_purge: drops the index and the column. What the job already cleared stays cleared (it cannot
-- come back); the sweep that reads the column must be gone first (deploy the code of before this migration, then run this). Safe to run twice.
BEGIN;
DROP INDEX IF EXISTS "ix_customers_erased_pending";
ALTER TABLE "customers" DROP COLUMN IF EXISTS "erased_data_attempted_at";
ALTER TABLE "customers" DROP COLUMN IF EXISTS "erased_data_purged_at";
COMMIT;
