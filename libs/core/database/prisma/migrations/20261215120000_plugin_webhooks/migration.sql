-- The webhooks of an integration plugin (TDD_10 §6.5): the installation keeps the secret that signs each delivery and the count
-- of failures that turns its webhooks off, as a tenant webhook does, and its tries go to the same delivery log.
ALTER TABLE "plugin_installations"
  ADD COLUMN "webhook_secret" BYTEA,
  ADD COLUMN "webhook_consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "webhook_last_failure_at" TIMESTAMP(3),
  ADD COLUMN "webhook_disabled_at" TIMESTAMP(3);

-- The log keeps 30 days of tries, so the table is small enough for the scan of the new rule. A try of the log belongs to a webhook of a store or to a plugin installation, never to both and never to none.
ALTER TABLE "webhook_deliveries" ALTER COLUMN "webhook_id" DROP NOT NULL;
ALTER TABLE "webhook_deliveries" ADD COLUMN "plugin_installation_id" TEXT;

ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugin_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "webhook_deliveries_one_owner_check" CHECK (("webhook_id" IS NULL) <> ("plugin_installation_id" IS NULL));

CREATE INDEX "webhook_deliveries_plugin_installation_id_created_at_idx" ON "webhook_deliveries"("plugin_installation_id", "created_at" DESC);
