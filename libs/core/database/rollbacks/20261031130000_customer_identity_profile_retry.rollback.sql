-- Rolls back 20261031130000_customer_identity_profile_retry: a profile whose read failed for lack of an answer is asked again by the next message.
BEGIN;

ALTER TABLE "customer_identities" DROP COLUMN "profile_retry_after";

COMMIT;
