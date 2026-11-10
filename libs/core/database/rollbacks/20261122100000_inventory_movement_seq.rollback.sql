-- Rolls back 20261122100000_inventory_movement_seq: drops the column that orders the ledger (and its sequence); the
-- kardex then falls back to created_at, which cannot tell the movements of one transaction apart. Safe to run twice.
BEGIN;

DROP INDEX IF EXISTS "inventory_movements_seq_key";
ALTER TABLE "inventory_movements" DROP COLUMN IF EXISTS "seq";

COMMIT;
