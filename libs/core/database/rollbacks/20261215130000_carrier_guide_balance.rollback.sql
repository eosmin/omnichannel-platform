-- Rolls back 20261215130000_carrier_guide_balance. DESTRUCTIVE: the policies, the whole ledger of guides (purchases, consumption,
-- refunds, adjustments) and the closed periods of the benefit are DROPPED with their rows (the balance is lost; take a copy of the
-- tables first if their rows matter), and the carriers:view_guide_balance and carriers:manage_guide_balance permissions are taken from the roles. The ledger is append-only, so
-- its triggers are dropped before its rows go. Run it before the code that reads these tables is brought back. Safe to run twice.
BEGIN;

DELETE FROM "permissions" WHERE "name" IN ('carriers:view_guide_balance', 'carriers:manage_guide_balance');

DROP TRIGGER IF EXISTS trg_carrier_guide_movements_no_truncate ON carrier_guide_movements;
DROP TRIGGER IF EXISTS trg_carrier_guide_movements_append_only ON carrier_guide_movements;
DROP TABLE IF EXISTS "carrier_benefit_periods";
DROP TABLE IF EXISTS "carrier_guide_movements";
DROP FUNCTION IF EXISTS forbid_carrier_guide_movement_change();
DROP TABLE IF EXISTS "carrier_guide_policies";
DROP INDEX IF EXISTS "shipment_events_store_id_status_occurred_at_idx";

COMMIT;
