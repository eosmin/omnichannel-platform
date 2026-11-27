-- Step 4B.7d (D13b-2a, Normativa DTE v2.0 section 11): a person of the store gives the files of an accepted fiscal document to its receiver
-- by hand (the files downloaded from the panel and handed over, or the representation on paper at the customer's request) and records it.
-- The row of the delivery that said NOT_SENT becomes SENT by the route MANUAL (the reason it was not sent by the system stays: it is why a
-- person had to), with who and when and the means. The row names no receiver and no address.
-- Rollback: rollbacks/20270208100000_fiscal_delivery_by_hand.rollback.sql
ALTER TABLE "fiscal_deliveries"
    ADD COLUMN "hand_means" TEXT,
    ADD COLUMN "handed_over_by" TEXT,
    ADD COLUMN "handed_over_at" TIMESTAMP(3);

ALTER TABLE "fiscal_deliveries" DROP CONSTRAINT "chk_fiscal_deliveries_outcome";
ALTER TABLE "fiscal_deliveries" ADD CONSTRAINT "chk_fiscal_deliveries_outcome" CHECK (
  (status = 'sent' AND route IN ('channel', 'email') AND reason IS NULL
      AND hand_means IS NULL AND handed_over_by IS NULL AND handed_over_at IS NULL)
  OR (status = 'sent' AND route = 'manual' AND hand_means IN ('download', 'paper')
      AND handed_over_by IS NOT NULL AND handed_over_at IS NOT NULL
      AND (reason IS NULL OR reason IN ('no_channel', 'files_unavailable', 'too_large', 'customer_erased')))
  OR (status = 'not_sent' AND route = 'none'
      AND reason IN ('no_channel', 'files_unavailable', 'too_large', 'customer_erased')
      AND hand_means IS NULL AND handed_over_by IS NULL AND handed_over_at IS NULL)
);
