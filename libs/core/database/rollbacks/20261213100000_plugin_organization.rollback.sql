BEGIN;

-- Safe to run twice. The plugins an organization registered cannot outlive the column that says whose they are: without it
-- they would be in every store's catalog, and the migration could not be applied again (its CHECK needs an organization on
-- every integration plugin). They are the registrations this migration made possible, so they go, with their installations
-- (an installation keeps its plugin row, so those go first). What later migrations hang from an installation is removed by
-- their own rollbacks, which run before this one.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'plugins' AND column_name = 'organization_id'
  ) THEN
    DELETE FROM "plugin_installations" WHERE "plugin_id" IN (SELECT "id" FROM "plugins" WHERE "organization_id" IS NOT NULL);
    DELETE FROM "plugins" WHERE "organization_id" IS NOT NULL;
  END IF;
END
$$;

ALTER TABLE "plugins" DROP CONSTRAINT IF EXISTS "plugins_official_has_no_organization_check";
ALTER TABLE "plugins" DROP CONSTRAINT IF EXISTS "plugins_integration_has_organization_check";
DROP INDEX IF EXISTS "plugins_organization_id_idx";
ALTER TABLE "plugins" DROP CONSTRAINT IF EXISTS "plugins_organization_id_fkey";
ALTER TABLE "plugins" DROP COLUMN IF EXISTS "organization_id";

COMMIT;
