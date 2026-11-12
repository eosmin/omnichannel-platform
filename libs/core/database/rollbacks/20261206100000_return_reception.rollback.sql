BEGIN;

-- Safe to run twice. The reception tables hold the scanning sessions and what each package was told (reason, note, the flag
-- decision); the returns, the stock moves and the customer flags they made live in their own tables and stay. Dropping them loses
-- the batch history only: run it together with the code that wrote it
DROP INDEX IF EXISTS "shipments_store_guide_normalized_idx";
DROP TABLE IF EXISTS "return_reception_items";
DROP TABLE IF EXISTS "return_reception_batches";

COMMIT;
