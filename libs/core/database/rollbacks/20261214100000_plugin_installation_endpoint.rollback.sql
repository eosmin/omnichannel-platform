BEGIN;

-- Safe to run twice. Only the address is lost: an installation that has no endpoint delivers nothing, so the plugin has to be
-- installed again before it receives webhooks.
ALTER TABLE "plugin_installations" DROP COLUMN IF EXISTS "webhook_endpoint";

COMMIT;
