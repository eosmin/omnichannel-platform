-- A notification the person asked to receive by email is marked when it is saved; the digest sends the
-- marked rows and clears the mark. The index serves the hourly scan for people with something pending.
-- AlterTable
ALTER TABLE "notifications" ADD COLUMN "email_pending_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "notifications_email_pending_at_idx" ON "notifications"("email_pending_at");
