-- Rolls back 20261112120000_message_discard. A reply that was discarded is brought back as the failed reply it was
-- (the deletion that came with the discard is undone: left alone it would show as the tombstone of a message the
-- customer never had), but only while its text is still kept. Once the retention of the deleted took the text
-- (`content_purged_at`) it stays deleted: an empty failed reply could not be sent again. The files that the discard
-- removed are not restored, whichever the case, and nothing records any more whether a failure was definitive.
BEGIN;

UPDATE "messages"
SET "deleted_at" = NULL, "deleted_by_type" = NULL, "deleted_by_id" = NULL
WHERE "discarded_at" IS NOT NULL AND "content_purged_at" IS NULL;

ALTER TABLE "messages" DROP COLUMN IF EXISTS "discarded_at";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "failure_definitive";

COMMIT;
