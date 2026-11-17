-- Stock ledger (TDD_16 §2, TDD_18 §4.2): the value a movement moved in or out of its level, in whole USD cents. The unit cost the movement
-- records is rounded to the cent, so units x unit cost is not what the level lost when the average has a fraction of a cent (5 units worth
-- 502, two leave: the level loses 201 and 2 x 100 is 200). The books post this column, so the inventory account and the stock value stay
-- equal to the cent. Null for what moves no value (a reserve, a release, units that were never on hand) and for the rows written before
-- this migration: those keep being valued at units x unit cost, the way their entries were posted. Existing rows are not backfilled.
ALTER TABLE inventory_movements ADD COLUMN value_cents bigint;
-- NOT VALID and then VALIDATE: the column is all null, and the validation of a big ledger holds only a light lock, so stock writes go on
ALTER TABLE inventory_movements
  ADD CONSTRAINT chk_inventory_movements_value CHECK (value_cents IS NULL OR value_cents >= 0) NOT VALID;
ALTER TABLE inventory_movements VALIDATE CONSTRAINT chk_inventory_movements_value;
