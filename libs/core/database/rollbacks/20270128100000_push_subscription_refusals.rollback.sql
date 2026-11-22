-- Rolls back 20270128100000_push_subscription_refusals: the counter and the id of the last notification that counted go (it only decides when a refused browser is dropped; nothing
-- else reads it). Run it before the code that writes `refused_count` is brought back. Safe to run twice.
BEGIN;

ALTER TABLE "push_subscriptions"
  DROP COLUMN IF EXISTS "refused_count",
  DROP COLUMN IF EXISTS "refused_notification_id";

COMMIT;
