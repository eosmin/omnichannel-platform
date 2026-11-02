-- The state of the text under a file that Instagram and Messenger send as a message of its own moves from
-- a flag in the JSON metadata of the message to a column, so that it can also say "unconfirmed" (the call
-- got no clear answer and the provider may have delivered it) and so that a later change can find it.
-- AlterTable
ALTER TABLE "messages" ADD COLUMN "caption_state" TEXT;

-- Messages written before: a failed caption keeps its meaning, one with an id was sent
UPDATE "messages"
SET "caption_state" = 'failed',
    "metadata" = "metadata" - 'captionFailed'
WHERE "metadata" ? 'captionFailed'
  AND "metadata"->'captionFailed' = 'true'::jsonb;

UPDATE "messages"
SET "caption_state" = 'sent'
WHERE "caption_channel_message_id" IS NOT NULL
  AND "caption_state" IS NULL;
