-- Rolls back 20261117100000_message_text_apart: the column goes. A message sent with its text apart would then
-- read that text as the one under its first file. Run it before the code that reads the column is brought back.
-- Safe to run twice.
BEGIN;

ALTER TABLE "messages" DROP COLUMN IF EXISTS "text_apart";

COMMIT;
