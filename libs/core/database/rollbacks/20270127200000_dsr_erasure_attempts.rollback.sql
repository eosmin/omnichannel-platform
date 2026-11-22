-- Rolls back 20270127200000_dsr_erasure_attempts: drops the three columns of the tries of the erasure sweep.
-- Run it before the code that reads them is brought back. Safe to run twice.
BEGIN;
ALTER TABLE "data_subject_requests"
  DROP COLUMN IF EXISTS "erasure_attempts",
  DROP COLUMN IF EXISTS "erasure_attempted_at",
  DROP COLUMN IF EXISTS "erasure_failure_code";
COMMIT;
