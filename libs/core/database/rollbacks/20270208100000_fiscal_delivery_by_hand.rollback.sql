-- Rolls back 20270208100000_fiscal_delivery_by_hand: a delivery recorded by hand goes back to NOT_SENT (the duty it closed is open again;
-- the audit log keeps who closed it). A row with no reason (a document that had no row, recorded by hand) gets the reason that says the
-- files could not be sent by the system. Safe to run twice: the data step runs only while the columns exist, every drop says IF EXISTS, and the
-- old check is put back after the new one is removed. The whole script is one transaction.
-- ORDER: roll the code back with this script or after it (the code reads the columns).
BEGIN;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'fiscal_deliveries' AND column_name = 'hand_means'
  ) THEN
    UPDATE "fiscal_deliveries"
       SET "status" = 'not_sent', "route" = 'none', "reason" = COALESCE("reason", 'files_unavailable'),
           "hand_means" = NULL, "handed_over_by" = NULL, "handed_over_at" = NULL
     WHERE "route" = 'manual';
  END IF;
END
$$;

ALTER TABLE "fiscal_deliveries" DROP CONSTRAINT IF EXISTS "chk_fiscal_deliveries_outcome";
ALTER TABLE "fiscal_deliveries" ADD CONSTRAINT "chk_fiscal_deliveries_outcome" CHECK (
  (status = 'sent' AND route IN ('channel', 'email') AND reason IS NULL)
  OR (status = 'not_sent' AND route = 'none'
      AND reason IN ('no_channel', 'files_unavailable', 'too_large', 'customer_erased'))
);

ALTER TABLE "fiscal_deliveries"
    DROP COLUMN IF EXISTS "hand_means",
    DROP COLUMN IF EXISTS "handed_over_by",
    DROP COLUMN IF EXISTS "handed_over_at";
COMMIT;
