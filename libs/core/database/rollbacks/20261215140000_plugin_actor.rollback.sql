BEGIN;

-- Safe to run twice. What is lost: which plugin edited, deleted or reacted. The reactions of plugins are deleted, because the check of
-- the earlier migration has no place for a reaction without a person (the customers' and the team's stay). The edits and the
-- deletions stay, with their `*_type` and no person, as the ones the channel reported always were.
DROP INDEX IF EXISTS uq_message_reactions_plugin;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'message_reactions' AND column_name = 'plugin_id'
  ) THEN
    DELETE FROM "message_reactions" WHERE "plugin_id" IS NOT NULL;
  END IF;
END
$$;
ALTER TABLE "message_reactions" DROP CONSTRAINT IF EXISTS "message_reactions_author_check";
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_author_check" CHECK (
    (author_type = 'customer' AND customer_identity_id IS NOT NULL AND user_id IS NULL)
    OR (author_type = 'agent' AND user_id IS NOT NULL AND customer_identity_id IS NULL)
    OR (author_type = 'external' AND customer_identity_id IS NULL AND user_id IS NULL)
) NOT VALID;
ALTER TABLE "message_reactions" VALIDATE CONSTRAINT "message_reactions_author_check";
ALTER TABLE "message_reactions" DROP COLUMN IF EXISTS "plugin_id";

ALTER TABLE "message_revisions" DROP CONSTRAINT IF EXISTS "message_revisions_actor_check";
ALTER TABLE "message_revisions" DROP COLUMN IF EXISTS "edited_by_plugin_id";
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_deleted_actor_check";
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_edited_actor_check";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "pending_edit_plugin_id";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "deleted_by_plugin_id";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "edited_by_plugin_id";

COMMIT;
