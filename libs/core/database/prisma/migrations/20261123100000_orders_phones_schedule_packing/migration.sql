-- Step 4.3 (PR A): what an order needs before the orders module exists. All additive.
--  * recipient_phones: the numbers the carriers receive, as national digits (TDD_02 §13).
--  * scheduled_delivery_date: a calendar day (DATE, no time of day), decision D18.
--  * packing_notes: the internal note for whoever packs the order (never shown to the customer).
--  * payment_reference and payment_proof_media_id: the v1.2 payments are recorded by hand (the method, the status, the
--    number of the transfer and the receipt); the online gateway is Phase 2.
--  * the filter index of the scheduled day, and the two indexes of order_items that the product delete (history count)
--    and the foreign keys need, so they stop scanning the table while the product row is locked (Step 4.1 debt).
--
-- Rows that already exist keep recipient_phones = {} (an order of an older shape has no phone to send a carrier): the
-- column cannot be backfilled in SQL, because the national number of customers.phone_normalized needs libphonenumber.
-- No code has created an order outside tests, so there is nothing real to fill; if real orders ever appear, backfill
-- them with `nationalPhoneNumber` (libs/core/messaging) before their first guide (IMPLEMENTATION_PLAN, Step 4.3).

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "packing_notes" TEXT,
ADD COLUMN     "payment_proof_media_id" TEXT,
ADD COLUMN     "payment_reference" TEXT,
ADD COLUMN     "recipient_phones" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "scheduled_delivery_date" DATE;

-- CreateIndex
CREATE INDEX "orders_store_id_scheduled_delivery_date_idx" ON "orders"("store_id", "scheduled_delivery_date");

-- CreateIndex
CREATE INDEX "order_items_product_id_idx" ON "order_items"("product_id");

-- CreateIndex
CREATE INDEX "order_items_variant_id_idx" ON "order_items"("variant_id");
