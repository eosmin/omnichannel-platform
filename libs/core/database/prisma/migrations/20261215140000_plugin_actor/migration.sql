-- A plugin as the actor of a change of a message (Step 5.6, PR M1c). Until now the columns that say who edited, who deleted and who
-- reacted held the id of a person, and a plugin has no user. Each gets a column for the plugin beside it, so that the one that did
-- it is never written as somebody else. All of them are nullable with no default (added without rewriting the table), have no foreign
-- key on purpose (it would scan `messages` to be added and again to delete a plugin; the id comes from the installation of the key,
-- like `author_plugin_id`) and are null for every row that exists.
ALTER TABLE "messages" ADD COLUMN "edited_by_plugin_id" TEXT;
ALTER TABLE "messages" ADD COLUMN "deleted_by_plugin_id" TEXT;
-- The plugin that asked for the edit that the channel has not taken yet: the worker records it as the editor when it settles
ALTER TABLE "messages" ADD COLUMN "pending_edit_plugin_id" TEXT;
ALTER TABLE "message_revisions" ADD COLUMN "edited_by_plugin_id" TEXT;
ALTER TABLE "message_reactions" ADD COLUMN "plugin_id" TEXT;

-- A change is made by a person or by a plugin, never by both. Added NOT VALID and NOT validated here: it is enforced for every new
-- write at once, and a scan of `messages` under the lock a migration holds (one transaction) is the outage NOT VALID avoids. Every
-- row that exists has a null in the new column, so none can break it; `VALIDATE CONSTRAINT` can be run by hand, outside a
-- transaction, to mark them valid.
ALTER TABLE "messages" ADD CONSTRAINT "messages_edited_actor_check"
  CHECK ("edited_by_id" IS NULL OR "edited_by_plugin_id" IS NULL) NOT VALID;
ALTER TABLE "messages" ADD CONSTRAINT "messages_deleted_actor_check"
  CHECK ("deleted_by_id" IS NULL OR "deleted_by_plugin_id" IS NULL) NOT VALID;
ALTER TABLE "message_revisions" ADD CONSTRAINT "message_revisions_actor_check"
  CHECK ("edited_by_id" IS NULL OR "edited_by_plugin_id" IS NULL) NOT VALID;

-- A reaction of a plugin is the system's (`author_type` = 'system') with the plugin in its own column; each author type keeps its own
-- id column and no other. The check is the one of the reactions migration with the fourth kind, replaced the same way.
ALTER TABLE "message_reactions" DROP CONSTRAINT "message_reactions_author_check";
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_author_check" CHECK (
    (author_type = 'customer' AND customer_identity_id IS NOT NULL AND user_id IS NULL AND plugin_id IS NULL)
    OR (author_type = 'agent' AND user_id IS NOT NULL AND customer_identity_id IS NULL AND plugin_id IS NULL)
    OR (author_type = 'external' AND customer_identity_id IS NULL AND user_id IS NULL AND plugin_id IS NULL)
    OR (author_type = 'system' AND plugin_id IS NOT NULL AND customer_identity_id IS NULL AND user_id IS NULL)
) NOT VALID;
ALTER TABLE "message_reactions" VALIDATE CONSTRAINT "message_reactions_author_check";

-- One reaction for each plugin and target, like a person's (raw SQL on coalesce(media_id, ''), as the two of the reactions migration)
CREATE UNIQUE INDEX uq_message_reactions_plugin
  ON "message_reactions" ("message_id", "plugin_id", (COALESCE("media_id", '')))
  WHERE "plugin_id" IS NOT NULL;
