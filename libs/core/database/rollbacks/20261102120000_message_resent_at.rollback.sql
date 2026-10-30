-- Rolls back 20261102120000_message_resent_at: a reply sent again is counted from when it was written, as before.
BEGIN;

ALTER TABLE "messages" DROP COLUMN "resent_at";

COMMIT;
