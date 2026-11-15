-- A channel plugin that runs outside the platform (TDD_10 §6.7): its icon, which the platform fetches once and keeps as
-- its own 128 px PNG, and the secret that signs the commands the platform sends it. `plugins.manifest` already exists.
ALTER TABLE "plugins" ADD COLUMN "icon_key" TEXT;

ALTER TABLE "plugin_installations"
  ADD COLUMN "command_secret" BYTEA,
  ADD COLUMN "command_secret_previous" BYTEA,
  ADD COLUMN "command_secret_rotated_at" TIMESTAMP(3);
