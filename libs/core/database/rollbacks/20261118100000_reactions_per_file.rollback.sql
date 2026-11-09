-- Rolls back 20261118100000_reactions_per_file: the reactions that were put on one file of an album are DELETED
-- (the old unique index allows one for each person and message, so they cannot stay), the two unique indexes
-- go back to (message, person), and the two columns are dropped. A quote of a file keeps quoting the message.
-- Run it before the code that reads the columns is brought back. Safe to run twice.
BEGIN;

DELETE FROM "message_reactions" WHERE "media_id" IS NOT NULL;

DROP INDEX IF EXISTS uq_message_reactions_customer;
DROP INDEX IF EXISTS uq_message_reactions_user;
CREATE UNIQUE INDEX IF NOT EXISTS "message_reactions_message_id_customer_identity_id_key"
  ON "message_reactions" ("message_id", "customer_identity_id");
CREATE UNIQUE INDEX IF NOT EXISTS "message_reactions_message_id_user_id_key"
  ON "message_reactions" ("message_id", "user_id");

DROP INDEX IF EXISTS "message_reactions_message_id_idx";
DROP INDEX IF EXISTS "message_reactions_media_id_idx";
ALTER TABLE "message_reactions" DROP CONSTRAINT IF EXISTS "message_reactions_media_id_fkey";
ALTER TABLE "message_reactions" DROP COLUMN IF EXISTS "media_id";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "reply_to_media_id";

COMMIT;
