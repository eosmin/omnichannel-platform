-- Rolls back 20261103120000_message_caption_channel_id: the id of the caption goes back to the metadata
-- of the message, where the echo lookup read it before.
BEGIN;

UPDATE "messages"
SET "metadata" = COALESCE("metadata", '{}'::jsonb) || jsonb_build_object('captionExternalId', "caption_channel_message_id")
WHERE "caption_channel_message_id" IS NOT NULL;

DROP INDEX "messages_conversation_id_caption_channel_message_id_idx";
ALTER TABLE "messages" DROP COLUMN "caption_channel_message_id";

COMMIT;
