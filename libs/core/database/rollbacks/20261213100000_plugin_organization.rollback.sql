BEGIN;

-- Safe to run twice. A plugin an organization registered would be visible to every store once the column is gone, so each
-- one is suspended first (a suspended plugin is in nobody's catalog and runs for nobody); the rows stay, because an
-- installation keeps its plugin row and the registration is the owner's data.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'plugins' AND column_name = 'organization_id'
  ) THEN
    UPDATE "plugins" SET "status" = 'suspended' WHERE "organization_id" IS NOT NULL;
  END IF;
END
$$;

ALTER TABLE "plugins" DROP CONSTRAINT IF EXISTS "plugins_official_has_no_organization_check";
ALTER TABLE "plugins" DROP CONSTRAINT IF EXISTS "plugins_integration_has_organization_check";
DROP INDEX IF EXISTS "plugins_organization_id_idx";
ALTER TABLE "plugins" DROP CONSTRAINT IF EXISTS "plugins_organization_id_fkey";
ALTER TABLE "plugins" DROP COLUMN IF EXISTS "organization_id";

COMMIT;
