-- Rolls back 20261028160000_ad_window_opened_at: the window of a conversation that came from an ad goes
-- back to 24 hours from the last message of the customer.
BEGIN;

ALTER TABLE "customer_identities" DROP COLUMN "ad_window_opened_at";

COMMIT;
