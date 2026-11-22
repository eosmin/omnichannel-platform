-- Rolls back 20270127500000_dsr_notice_export: drops the columns of the closing notice and of the export tries.
-- Run it before the code that reads them is brought back. Safe to run twice.
BEGIN;
ALTER TABLE "data_subject_requests"
  DROP COLUMN IF EXISTS "notice_attempts",
  DROP COLUMN IF EXISTS "notice_queued_at",
  DROP COLUMN IF EXISTS "notice_sent_at",
  DROP COLUMN IF EXISTS "notice_failed_at",
  DROP COLUMN IF EXISTS "export_attempts",
  DROP COLUMN IF EXISTS "export_attempted_at",
  DROP COLUMN IF EXISTS "export_failure_code";
COMMIT;
