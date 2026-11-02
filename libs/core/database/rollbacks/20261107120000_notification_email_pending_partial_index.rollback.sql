-- Rolls back 20261107120000_notification_email_pending_partial_index: the full index comes back.
BEGIN;

DROP INDEX ix_notifications_email_pending;
CREATE INDEX "notifications_email_pending_at_idx" ON "notifications"("email_pending_at");

COMMIT;
