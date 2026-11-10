-- Step 4.2 (PR A2): the order of the ledger. Every movement of a transaction has the same created_at (the default is
-- the start of the transaction, to the millisecond) and the ids are random, so the kardex could not tell the order of
-- two movements of one order. `seq` is written as each row is inserted, under the lock of its level, so the movements
-- of one item are in it in the order they happened. The rows that exist (the opening stock of the fixtures) are
-- numbered by (created_at, id) first, and the sequence goes on from there: this is what BIGSERIAL makes, in steps.
CREATE SEQUENCE "inventory_movements_seq_seq" AS BIGINT;
ALTER TABLE "inventory_movements" ADD COLUMN "seq" BIGINT;

WITH numbered AS (
  SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS n FROM "inventory_movements"
)
UPDATE "inventory_movements" AS m SET "seq" = numbered.n FROM numbered WHERE numbered."id" = m."id";

SELECT setval('inventory_movements_seq_seq', COALESCE((SELECT max("seq") FROM "inventory_movements"), 0) + 1, false);

ALTER TABLE "inventory_movements" ALTER COLUMN "seq" SET DEFAULT nextval('inventory_movements_seq_seq');
ALTER TABLE "inventory_movements" ALTER COLUMN "seq" SET NOT NULL;
ALTER SEQUENCE "inventory_movements_seq_seq" OWNED BY "inventory_movements"."seq";

CREATE UNIQUE INDEX "inventory_movements_seq_key" ON "inventory_movements"("seq");
