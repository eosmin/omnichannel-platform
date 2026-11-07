-- The files an agent sends in one message (several, in order) each have their own place and delivery state,
-- so that a retry sends only the ones the provider has not taken. All nullable: a file of an inbound message,
-- a gallery file and every file sent before this migration have none, and the message's own state is theirs.
-- AlterTable
ALTER TABLE "media"
  ADD COLUMN "position" INTEGER,
  ADD COLUMN "delivery_status" TEXT,
  ADD COLUMN "channel_message_id" TEXT,
  ADD COLUMN "send_error_code" TEXT,
  ADD COLUMN "sent_at" TIMESTAMP(3);

-- The echo and the receipts of a file that is not the first of its message find it by the provider id
-- CreateIndex
CREATE INDEX "media_store_id_channel_message_id_idx" ON "media"("store_id", "channel_message_id");
