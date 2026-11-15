-- Rollback of 20261214110000_plugin_channel_manifest. Safe to run twice: every statement is guarded.
BEGIN;

-- The channel plugins an organization registered by manifest cannot outlive this migration: the code before it has no adapter
-- for them, and the catalog would list a channel nobody can run. They go with their installations and connections (an
-- installation keeps its plugin row by RESTRICT, so those go first). Re-appliable: when the column is gone they are gone.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'plugins' AND column_name = 'icon_key'
  ) THEN
    DELETE FROM "channel_connections" WHERE "installation_id" IN (
      SELECT i."id" FROM "plugin_installations" i JOIN "plugins" p ON p."id" = i."plugin_id"
      WHERE p."type" = 'channel' AND p."organization_id" IS NOT NULL
    );
    DELETE FROM "plugin_installations" WHERE "plugin_id" IN (
      SELECT "id" FROM "plugins" WHERE "type" = 'channel' AND "organization_id" IS NOT NULL
    );
    DELETE FROM "plugins" WHERE "type" = 'channel' AND "organization_id" IS NOT NULL;
  END IF;
END
$$;

ALTER TABLE "plugin_installations"
  DROP COLUMN IF EXISTS "command_secret_rotated_at",
  DROP COLUMN IF EXISTS "command_secret_previous",
  DROP COLUMN IF EXISTS "command_secret";

ALTER TABLE "plugins" DROP COLUMN IF EXISTS "icon_key";

COMMIT;
