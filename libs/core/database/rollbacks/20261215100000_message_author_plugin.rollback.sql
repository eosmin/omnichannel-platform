BEGIN;

-- Safe to run twice. Only the trace is lost: which plugin wrote a message and under what nickname. The messages stay, with their
-- `author_type` (a plugin message written as `system` reads as the system's, one written as `agent` as that person's).
ALTER TABLE "messages" DROP COLUMN IF EXISTS "author_nickname";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "author_plugin_id";

COMMIT;
