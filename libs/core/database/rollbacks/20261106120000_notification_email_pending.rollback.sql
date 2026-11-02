-- Rolls back 20261106120000_notification_email_pending: the digest loses its mark, so what was pending
-- by email at that moment is never sent.
BEGIN;

DROP INDEX "notifications_email_pending_at_idx";
ALTER TABLE "notifications" DROP COLUMN "email_pending_at";

COMMIT;
