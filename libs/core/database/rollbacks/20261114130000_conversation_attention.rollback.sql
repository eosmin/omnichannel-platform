-- Rolls back 20261114130000_conversation_attention: the two indexes and the four columns are dropped. The
-- marks that were up and the reminders left on snoozed conversations are lost (a mark only raised a row;
-- a snoozed conversation still wakes at its time, now without the reminder). Run it after the code that
-- reads the columns is reverted.
BEGIN;

DROP INDEX IF EXISTS "conversations_attention_idx";
DROP INDEX IF EXISTS "conversations_store_list_order_idx";

ALTER TABLE "conversations"
  DROP COLUMN "attention_note",
  DROP COLUMN "attention_at",
  DROP COLUMN "attention_reason",
  DROP COLUMN "snooze_note";

COMMIT;
