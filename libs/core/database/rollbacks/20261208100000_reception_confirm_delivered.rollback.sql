BEGIN;

-- Safe to run twice. Complete or empty the draft batches first: one that holds a confirmed DELIVERED package would fail it on
-- completing once the column is gone (the old code has no confirmation).
-- The column only records that the agent confirmed a package whose guide was DELIVERED; a batch still waiting to
-- be completed would lose that confirmation (and refuse the package), the returns already received keep theirs
ALTER TABLE "return_reception_items" DROP COLUMN IF EXISTS "confirm_delivered";

COMMIT;
