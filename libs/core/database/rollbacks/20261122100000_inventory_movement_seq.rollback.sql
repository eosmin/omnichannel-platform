-- Rolls back 20261122100000_inventory_movement_seq: drops the column that orders the ledger (and its sequence); the
-- kardex then falls back to created_at, which cannot tell the movements of one transaction apart. Safe to run twice.
BEGIN;

DROP INDEX IF EXISTS "inventory_movements_store_id_product_id_warehouse_id_varian_idx";
DROP INDEX IF EXISTS "inventory_movements_seq_key";
ALTER TABLE "inventory_movements" DROP COLUMN IF EXISTS "seq";
-- The column owns its sequence; this names it for a run that stopped before the ownership was set
DROP SEQUENCE IF EXISTS "inventory_movements_seq_seq";

COMMIT;
