BEGIN;

-- Safe to run twice. The constraints and the index only: a window the migration brought to a bound stays at that bound (the
-- value it had before is not kept), and nothing else changes.
ALTER TABLE "retention_settings"
  DROP CONSTRAINT IF EXISTS "retention_settings_conversation_days_check",
  DROP CONSTRAINT IF EXISTS "retention_settings_media_days_check",
  DROP CONSTRAINT IF EXISTS "retention_settings_analytics_days_check",
  DROP CONSTRAINT IF EXISTS "retention_settings_notification_days_check";
DROP INDEX IF EXISTS "metrics_hourly_hour_idx";

COMMIT;
