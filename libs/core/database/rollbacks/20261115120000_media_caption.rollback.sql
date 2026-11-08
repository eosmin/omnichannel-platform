-- Rolls back 20261115120000_media_caption: the text under each file, its state and its provider id are
-- dropped. The text under the FIRST file of each message stays, in `messages.content`; the texts under the
-- others are lost, and the echo of a text that Instagram or Messenger sent apart is stored as a message of the
-- owner if it arrives later. Run it after the code that reads the columns is reverted.
BEGIN;

DROP INDEX IF EXISTS "media_store_id_caption_channel_message_id_idx";

ALTER TABLE "media"
  DROP COLUMN "caption_channel_message_id",
  DROP COLUMN "caption_state",
  DROP COLUMN "caption";

COMMIT;
