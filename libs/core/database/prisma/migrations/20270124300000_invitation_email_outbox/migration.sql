-- Step 7.1-H: the email of an invitation is an outbox written in the same transaction as the invitation. The columns hold the email the
-- worker still has to send, sealed (AES-256-GCM, the key of the channel credentials): it carries the link, which holds the only copy of the
-- token. A job delivers it with retries and clears it when sent. No table is created, so no policy: `invitations` keeps what it has.
-- Rollback: rollbacks/20270124300000_invitation_email_outbox.rollback.sql
ALTER TABLE "invitations" ADD COLUMN "email_outbox" BYTEA;
ALTER TABLE "invitations" ADD COLUMN "email_claimed_at" TIMESTAMP(3);
ALTER TABLE "invitations" ADD COLUMN "email_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "invitations" ADD COLUMN "email_sent_at" TIMESTAMP(3);

-- Few rows (the emails not delivered yet): the sweep reads exactly them
CREATE INDEX "ix_invitations_email_pending" ON "invitations" ("store_id", "created_at")
  WHERE "email_outbox" IS NOT NULL;
