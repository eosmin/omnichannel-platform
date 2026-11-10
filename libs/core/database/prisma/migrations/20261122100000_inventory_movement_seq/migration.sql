-- Step 4.2 (PR A2): the order of the ledger. Every movement of a transaction has the same created_at (the default is
-- the start of the transaction, to the millisecond) and the ids are random, so the kardex could not tell the order of
-- two movements of one order. `seq` is written as each row is inserted, under the lock of its level, so the movements
-- of one item are in it in the order they happened.
ALTER TABLE "inventory_movements" ADD COLUMN "seq" BIGSERIAL NOT NULL;

CREATE UNIQUE INDEX "inventory_movements_seq_key" ON "inventory_movements"("seq");
