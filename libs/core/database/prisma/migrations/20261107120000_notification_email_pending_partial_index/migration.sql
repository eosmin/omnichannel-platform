-- Almost every notification has no email pending (the mark is cleared once the mail is queued, and
-- most types have no email at all), so the scan of the digest reads a small part of the table. A
-- partial index holds only the marked rows, which keeps it small and cheap to write. Prisma cannot
-- express it, so it lives here and not in schema.prisma, like the other partial indexes.
DROP INDEX "notifications_email_pending_at_idx";

CREATE INDEX ix_notifications_email_pending ON notifications (email_pending_at) WHERE email_pending_at IS NOT NULL;
