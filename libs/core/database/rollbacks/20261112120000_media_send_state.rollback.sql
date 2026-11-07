-- Rolls back 20261112120000_media_send_state: the per-file delivery state is dropped. A message with several
-- files keeps its own delivery state and its first provider id; the ids of the others (used to match the echo
-- and the receipts of those files) are lost, and an echo that arrives later is stored as a message of the owner.
BEGIN;

DROP INDEX IF EXISTS "media_store_id_channel_message_id_idx";

ALTER TABLE "media"
  DROP COLUMN "position",
  DROP COLUMN "delivery_status",
  DROP COLUMN "channel_message_id",
  DROP COLUMN "send_error_code",
  DROP COLUMN "sent_at";

COMMIT;
