-- Rolls back 20261124100000_order_number_counter: drops the counter of the order numbers of a store.
-- The orders keep the numbers they were given; a new order after a roll-forward again starts from the largest digits-only
-- number of the store (the migration recomputes it).
-- Roll the api back FIRST: while the code that takes its numbers from this column is deployed, every order creation fails
-- once the column is gone. Safe to run twice.
BEGIN;

ALTER TABLE "store_settings" DROP COLUMN IF EXISTS "next_order_number";

COMMIT;
