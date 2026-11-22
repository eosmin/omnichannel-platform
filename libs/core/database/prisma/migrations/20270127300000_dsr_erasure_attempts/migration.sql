-- Step 7.2-H2b-1: what the nightly sweep that carries out an approved erasure writes about each try. The count is written BEFORE the
-- erasure starts, so a request that kills the process every time stops being taken after a few tries; the code is the name of the
-- error class, never its message (a message can carry a fragment of the data).
-- Rollback: rollbacks/20270127300000_dsr_erasure_attempts.rollback.sql
ALTER TABLE "data_subject_requests"
  ADD COLUMN "erasure_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "erasure_attempted_at" TIMESTAMP(3),
  ADD COLUMN "erasure_failure_code" TEXT;
