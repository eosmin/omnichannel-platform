-- Rolls back 20261109120000_message_caption_state: a failed caption goes back to the flag in the metadata.
-- An unconfirmed one has no place there and is lost (the thread then shows nothing for it).
BEGIN;

UPDATE "messages"
SET "metadata" = COALESCE(CASE WHEN jsonb_typeof("metadata") = 'object' THEN "metadata" END, '{}'::jsonb) || jsonb_build_object('captionFailed', true)
WHERE "caption_state" = 'failed';

ALTER TABLE "messages" DROP COLUMN "caption_state";

COMMIT;
