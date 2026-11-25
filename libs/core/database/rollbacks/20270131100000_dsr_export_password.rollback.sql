-- Rolls back 20270131100000_dsr_export_password: the sealed passwords go, so the encrypted ZIPs still in the bucket can no longer be opened by
-- anyone (a completed export is kept `DSR_EXPORT_LINK_DAYS` days at most; the exports are asked for again). Safe to run twice.
BEGIN;
ALTER TABLE "data_subject_requests" DROP COLUMN IF EXISTS "result_password_sealed";
COMMIT;
