-- Rolls back 20261028120000_plugin_installations: the connections no longer hang from an
-- installation, and the key of an installation is required again.
--
-- An installation without a key can only be an official channel, which exists because of this
-- migration (the ones it wrote and the ones stores made after): they go, and with them the plugin
-- rows nobody installs any more (the official ones the boot of the api writes again, and the ones
-- the migration wrote for connections of other plugins).
BEGIN;

DROP INDEX "channel_connections_installation_id_idx";
ALTER TABLE "channel_connections" DROP CONSTRAINT "channel_connections_installation_id_fkey";
ALTER TABLE "channel_connections" DROP COLUMN "installation_id";

DELETE FROM "plugin_installations" WHERE "api_key_hash" IS NULL;
DELETE FROM "plugins" WHERE ("is_official" OR "author_name" = 'migration') AND NOT EXISTS (
  SELECT 1 FROM "plugin_installations" WHERE "plugin_installations"."plugin_id" = "plugins"."id"
);
ALTER TABLE "plugin_installations" ALTER COLUMN "api_key_hash" SET NOT NULL;
ALTER TABLE "plugin_installations" ALTER COLUMN "api_key_prefix" SET NOT NULL;

COMMIT;
