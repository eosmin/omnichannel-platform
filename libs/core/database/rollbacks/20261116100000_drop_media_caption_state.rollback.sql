-- Rolls back 20261116100000_drop_media_caption_state: the two columns and the index come back empty. The
-- state and the provider id that they held are not recovered (they were not written after the code that
-- stopped using them). Run it before the code that reads the columns is brought back. Safe to run twice.
BEGIN;

ALTER TABLE "media"
  ADD COLUMN IF NOT EXISTS "caption_state" TEXT,
  ADD COLUMN IF NOT EXISTS "caption_channel_message_id" TEXT;

CREATE INDEX IF NOT EXISTS "media_store_id_caption_channel_message_id_idx"
  ON "media" ("store_id", "caption_channel_message_id");

COMMIT;
