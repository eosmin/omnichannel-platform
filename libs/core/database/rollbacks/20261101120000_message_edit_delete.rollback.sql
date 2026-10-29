-- Rolls back 20261101120000_message_edit_delete: every revision is lost, and so is what the messages
-- know of their edits and deletions (a deleted message shows again with the text it still holds, and
-- one whose text was purged shows empty). Nothing else on the messages changes.
BEGIN;

DELETE FROM "permissions" WHERE "name" = 'messages:view_deleted';

DROP TABLE IF EXISTS "message_revisions";

DROP INDEX IF EXISTS "messages_change_requested_at_idx";

DROP INDEX IF EXISTS "messages_deleted_at_idx";

ALTER TABLE "messages"
    DROP COLUMN IF EXISTS "version",
    DROP COLUMN IF EXISTS "edited_at",
    DROP COLUMN IF EXISTS "edited_by_type",
    DROP COLUMN IF EXISTS "edited_by_id",
    DROP COLUMN IF EXISTS "pending_content",
    DROP COLUMN IF EXISTS "edit_status",
    DROP COLUMN IF EXISTS "edit_error",
    DROP COLUMN IF EXISTS "deleted_at",
    DROP COLUMN IF EXISTS "deleted_by_type",
    DROP COLUMN IF EXISTS "deleted_by_id",
    DROP COLUMN IF EXISTS "delete_status",
    DROP COLUMN IF EXISTS "delete_error",
    DROP COLUMN IF EXISTS "change_requested_at",
    DROP COLUMN IF EXISTS "content_purged_at";

COMMIT;
