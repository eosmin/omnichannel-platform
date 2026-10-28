-- D19: every channel connection hangs from the installation of its plugin in the store.
--
-- An official channel has no API key, so the key columns of an installation become optional.
-- The connections that already exist get what they now need: a plugin row for their plugin (the
-- boot of the api completes the name and the manifest of the official ones) and an active
-- installation per store and plugin, written by 'migration'.
ALTER TABLE "plugin_installations" ALTER COLUMN "api_key_prefix" DROP NOT NULL;
ALTER TABLE "plugin_installations" ALTER COLUMN "api_key_hash" DROP NOT NULL;

ALTER TABLE "channel_connections" ADD COLUMN "installation_id" TEXT;

INSERT INTO "plugins" ("id", "name", "author_name", "author_email", "type", "is_official", "manifest", "pricing_model", "status", "updated_at")
SELECT DISTINCT
  "plugin_id",
  "plugin_id",
  'migration',
  'migration@localhost',
  'channel',
  "plugin_id" IN ('whatsapp', 'instagram', 'messenger', 'web_widget', 'email'),
  '{}'::jsonb,
  'free',
  'approved',
  CURRENT_TIMESTAMP
FROM "channel_connections"
ON CONFLICT ("id") DO NOTHING;

-- Active only where the store still has a connection that is not disconnected; a pair whose
-- connections are all disconnected is revoked, so the store installs the plugin again on purpose.
INSERT INTO "plugin_installations" ("id", "store_id", "plugin_id", "scopes", "status", "installed_by", "revoked_at", "updated_at")
SELECT
  gen_random_uuid()::text, "store_id", "plugin_id", ARRAY[]::text[],
  CASE WHEN bool_or("status" <> 'disconnected') THEN 'active' ELSE 'revoked' END,
  'migration',
  CASE WHEN bool_or("status" <> 'disconnected') THEN NULL ELSE CURRENT_TIMESTAMP END,
  CURRENT_TIMESTAMP
FROM "channel_connections"
GROUP BY "store_id", "plugin_id"
ON CONFLICT ("store_id", "plugin_id") DO NOTHING;

UPDATE "channel_connections" AS c
SET "installation_id" = i."id"
FROM "plugin_installations" AS i
WHERE i."store_id" = c."store_id" AND i."plugin_id" = c."plugin_id";

ALTER TABLE "channel_connections" ALTER COLUMN "installation_id" SET NOT NULL;
ALTER TABLE "channel_connections"
  ADD CONSTRAINT "channel_connections_installation_id_fkey"
  FOREIGN KEY ("installation_id") REFERENCES "plugin_installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "channel_connections_installation_id_idx" ON "channel_connections"("installation_id");
