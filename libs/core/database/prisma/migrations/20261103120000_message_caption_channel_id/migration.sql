-- The provider id of the message that carried the caption of a file (Instagram, Messenger) moves from
-- the JSON metadata of the message to a column of its own, so that the echo of that message is found
-- with an index and not by reading the JSON of every message of the conversations of the identity.
-- AlterTable
ALTER TABLE "messages" ADD COLUMN "caption_channel_message_id" TEXT;

-- Messages written before: the id is copied and the key leaves the metadata
UPDATE "messages"
SET "caption_channel_message_id" = "metadata"->>'captionExternalId',
    "metadata" = "metadata" - 'captionExternalId'
WHERE "metadata" ? 'captionExternalId'
  AND jsonb_typeof("metadata"->'captionExternalId') = 'string';

-- CreateIndex
CREATE INDEX "messages_conversation_id_caption_channel_message_id_idx" ON "messages"("conversation_id", "caption_channel_message_id");
