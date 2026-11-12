BEGIN;

-- Safe to run twice. The column only remembers what the carrier was last told, so dropping it loses nothing the guides do not
-- hold: the next sync of a pickup would send its count again
ALTER TABLE "pickup_requests" DROP COLUMN IF EXISTS "carrier_package_count";

COMMIT;
