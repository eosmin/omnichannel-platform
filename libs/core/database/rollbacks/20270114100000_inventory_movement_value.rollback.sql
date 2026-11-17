-- Rolls back 20270114100000_inventory_movement_value: drops the column that holds the value a stock movement moved. The books would value
-- the units that left at units x unit cost again, as before; the entries already posted stay as they are (the journal is never rewritten).
-- Safe to run twice.
BEGIN;

ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS chk_inventory_movements_value;
ALTER TABLE inventory_movements DROP COLUMN IF EXISTS value_cents;

COMMIT;
