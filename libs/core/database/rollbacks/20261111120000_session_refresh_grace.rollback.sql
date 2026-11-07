-- Rolls back 20261111120000_session_refresh_grace: the mark of the grace is lost. The code that came
-- before knows no grace and revokes the family on any consumed token, so nothing else needs undoing.
BEGIN;

ALTER TABLE "sessions" DROP COLUMN IF EXISTS "grace_used_at";

COMMIT;
