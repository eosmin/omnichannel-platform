-- The address that passed the install challenge (TDD_10 §6.3), kept on the installation: a newer version of the manifest may name
-- another endpoint, and a delivery goes only where the owner's install was checked (Step 5.6, PR P3 reads it).
ALTER TABLE "plugin_installations" ADD COLUMN "webhook_endpoint" TEXT;
