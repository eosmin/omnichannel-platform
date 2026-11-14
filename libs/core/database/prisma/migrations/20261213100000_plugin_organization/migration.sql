-- A plugin the owner registers by pasting its manifest (D10) belongs to the organization that registered it: only the
-- stores of that organization see it in the catalog and install it. Null stays for the plugins the platform ships and the
-- ones its code registers, which every store sees.
ALTER TABLE "plugins" ADD COLUMN "organization_id" TEXT;

ALTER TABLE "plugins"
  ADD CONSTRAINT "plugins_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "plugins_organization_id_idx" ON "plugins"("organization_id");

-- The database refuses what the api refuses: an official plugin is the platform's, never an organization's, and an
-- integration plugin (the ones that run outside the platform) is always an organization's, so no row of that kind is ever
-- in every store's catalog.
ALTER TABLE "plugins"
  ADD CONSTRAINT "plugins_official_has_no_organization_check" CHECK (NOT "is_official" OR "organization_id" IS NULL),
  ADD CONSTRAINT "plugins_integration_has_organization_check" CHECK ("type" <> 'integration' OR "organization_id" IS NOT NULL);
