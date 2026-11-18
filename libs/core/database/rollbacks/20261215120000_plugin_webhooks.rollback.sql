BEGIN;

-- Safe to run twice (TDD_03 §5.4): each statement that names a column of the migration runs only while the column is there.
-- The tries of the plugin webhooks are lost (the log of the tenant webhooks stays), and so are the secrets and
-- the failure counts: a plugin that was installed has to be installed again to get a new secret before it receives webhooks.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('webhook_deliveries') AND attname = 'plugin_installation_id' AND NOT attisdropped
  ) THEN
    DELETE FROM "webhook_deliveries" WHERE "plugin_installation_id" IS NOT NULL;
  END IF;
END
$$;

-- The row-level security policy of webhook_deliveries (migration 20270121110000_rls_phase1) reads the column that goes: it goes first,
-- or the column cannot be dropped. Nothing to drop when that migration is not there.
DROP POLICY IF EXISTS "webhook_deliveries_tenant" ON "webhook_deliveries";

DROP INDEX IF EXISTS "webhook_deliveries_plugin_installation_id_created_at_idx";
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT IF EXISTS "webhook_deliveries_one_owner_check";
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT IF EXISTS "webhook_deliveries_plugin_installation_id_fkey";
ALTER TABLE "webhook_deliveries" DROP COLUMN IF EXISTS "plugin_installation_id";
ALTER TABLE "webhook_deliveries" ALTER COLUMN "webhook_id" SET NOT NULL;

-- An installation that was given a secret by this migration's code has no way to get one back: its endpoint goes with it, so that
-- the state is the one of an installation that was never set up for webhooks (the plugin has to be installed again). Endpoints of
-- installations that never had a secret (made before this migration) are not touched.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('plugin_installations') AND attname = 'webhook_secret' AND NOT attisdropped
  ) THEN
    UPDATE "plugin_installations" SET "webhook_endpoint" = NULL WHERE "webhook_secret" IS NOT NULL;
  END IF;
END
$$;

ALTER TABLE "plugin_installations"
  DROP COLUMN IF EXISTS "webhook_secret",
  DROP COLUMN IF EXISTS "webhook_consecutive_failures",
  DROP COLUMN IF EXISTS "webhook_last_failure_at",
  DROP COLUMN IF EXISTS "webhook_disabled_at";

COMMIT;
