-- The windows of a store's retention settings have floors and ceilings (RetentionBounds in libs/core/platform/compliance):
-- the database refuses what the API refuses, so a hand-written row cannot ask the nightly run to erase a store's history.
-- A row already outside the bounds (made by hand; the API never wrote one) is brought to the nearest bound first, so the constraints can be added.
UPDATE "retention_settings" SET
  "conversation_days" = LEAST(GREATEST("conversation_days", 30), 3650),
  "media_days" = LEAST(GREATEST("media_days", 30), 3650),
  "analytics_days" = LEAST(GREATEST("analytics_days", 90), 1095),
  "notification_days" = LEAST(GREATEST("notification_days", 7), 365)
WHERE "conversation_days" NOT BETWEEN 30 AND 3650
   OR "media_days" NOT BETWEEN 30 AND 3650
   OR "analytics_days" NOT BETWEEN 90 AND 1095
   OR "notification_days" NOT BETWEEN 7 AND 365;

ALTER TABLE "retention_settings"
  ADD CONSTRAINT "retention_settings_conversation_days_check" CHECK ("conversation_days" BETWEEN 30 AND 3650),
  ADD CONSTRAINT "retention_settings_media_days_check" CHECK ("media_days" BETWEEN 30 AND 3650),
  ADD CONSTRAINT "retention_settings_analytics_days_check" CHECK ("analytics_days" BETWEEN 90 AND 1095),
  ADD CONSTRAINT "retention_settings_notification_days_check" CHECK ("notification_days" BETWEEN 7 AND 365);

-- The purge of the hourly rollup reads the hours across the stores (DataRetentionPolicies.METRICS_HOURLY).
CREATE INDEX "metrics_hourly_hour_idx" ON "metrics_hourly"("hour");
