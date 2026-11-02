-- Rolls back 20261108120000_export_progress: the exports center loses the progress bar of a file being written.
BEGIN;

ALTER TABLE "exports" DROP COLUMN IF EXISTS "progress";

COMMIT;
