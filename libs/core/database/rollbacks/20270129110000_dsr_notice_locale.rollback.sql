-- Rolls back 20270129110000_dsr_notice_locale: drops the language of the closing notice.
-- Run it before the code that reads it is brought back. Safe to run twice.
BEGIN;
ALTER TABLE "data_subject_requests" DROP COLUMN IF EXISTS "notice_locale";
COMMIT;
