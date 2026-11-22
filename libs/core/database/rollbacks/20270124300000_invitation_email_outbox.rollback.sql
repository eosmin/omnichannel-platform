-- Rolls back 20270124300000_invitation_email_outbox: drops the index and the five columns. An email that was still waiting in the outbox is
-- lost (the invitee needs a resend); the sweep and the delivery that read the columns must be gone first (deploy the code of before this
-- migration, then run this). Safe to run twice.
BEGIN;
DROP INDEX IF EXISTS "ix_invitations_email_pending";
ALTER TABLE "invitations" DROP COLUMN IF EXISTS "email_sent_at";
ALTER TABLE "invitations" DROP COLUMN IF EXISTS "email_retry_at";
ALTER TABLE "invitations" DROP COLUMN IF EXISTS "email_attempts";
ALTER TABLE "invitations" DROP COLUMN IF EXISTS "email_claimed_at";
ALTER TABLE "invitations" DROP COLUMN IF EXISTS "email_outbox";
COMMIT;
