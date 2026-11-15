BEGIN;

-- Safe to run twice. The tries of the plugin webhooks are lost (the log of the tenant webhooks stays), and so are the secrets and
-- the failure counts: a plugin that was installed has to be installed again to get a new secret before it receives webhooks.
DELETE FROM "webhook_deliveries" WHERE "plugin_installation_id" IS NOT NULL;

DROP INDEX IF EXISTS "webhook_deliveries_plugin_installation_id_created_at_idx";
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT IF EXISTS "webhook_deliveries_one_owner_check";
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT IF EXISTS "webhook_deliveries_plugin_installation_id_fkey";
ALTER TABLE "webhook_deliveries" DROP COLUMN IF EXISTS "plugin_installation_id";
ALTER TABLE "webhook_deliveries" ALTER COLUMN "webhook_id" SET NOT NULL;

-- An installation that was given a secret by this migration's code has no way to get one back: its endpoint goes with it, so that
-- the state is the one of an installation that was never set up for webhooks (the plugin has to be installed again). Endpoints of
-- installations that never had a secret (made before this migration) are not touched.
UPDATE "plugin_installations" SET "webhook_endpoint" = NULL WHERE "webhook_secret" IS NOT NULL;

ALTER TABLE "plugin_installations"
  DROP COLUMN IF EXISTS "webhook_secret",
  DROP COLUMN IF EXISTS "webhook_consecutive_failures",
  DROP COLUMN IF EXISTS "webhook_last_failure_at",
  DROP COLUMN IF EXISTS "webhook_disabled_at";

COMMIT;
