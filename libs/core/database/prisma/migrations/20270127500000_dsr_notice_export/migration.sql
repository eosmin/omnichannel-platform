-- Step 7.2-H2b-2: what the data request flow records about (1) the closing notice of an ended request, so a mail that never reached the person
-- is visible to the reviewer instead of lost, and (2) the tries of the export of an access or portability request (written BEFORE each try, so
-- a request that kills the process stops being taken). The failure code is the name of an error, never its message.
-- Rollback: rollbacks/20270127500000_dsr_notice_export.rollback.sql
ALTER TABLE "data_subject_requests"
  ADD COLUMN "notice_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "notice_queued_at" TIMESTAMP(3),
  ADD COLUMN "notice_sent_at" TIMESTAMP(3),
  ADD COLUMN "notice_failed_at" TIMESTAMP(3),
  ADD COLUMN "export_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "export_attempted_at" TIMESTAMP(3),
  ADD COLUMN "export_failure_code" TEXT;
