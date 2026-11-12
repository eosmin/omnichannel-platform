BEGIN;

-- Safe to run twice. The index only serves the list of returns (newest first, by store); dropping it makes that list slower and
-- loses no data
DROP INDEX IF EXISTS "order_returns_store_created_idx";

COMMIT;
