-- Rolls back 20261031120000_customer_identity_profile: the customer shows the name the webhook carried, or none, and the photo is gone.
BEGIN;

ALTER TABLE "customer_identities"
  DROP COLUMN "profile_fetch_error",
  DROP COLUMN "profile_fetched_at",
  DROP COLUMN "avatar_url",
  DROP COLUMN "username";

COMMIT;
