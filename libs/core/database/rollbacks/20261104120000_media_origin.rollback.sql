-- Rolls back 20261104120000_media_origin: the files of the ads lose their link to the origin. The rows
-- are deleted first (a row with no origin would be an orphan: its purpose says it belongs to one), and
-- the orphan cleanup removes their objects from the bucket.
BEGIN;

DELETE FROM "media" WHERE "origin_id" IS NOT NULL;

ALTER TABLE "media" DROP CONSTRAINT "media_origin_id_fkey";
DROP INDEX "media_origin_id_idx";
ALTER TABLE "media" DROP COLUMN "origin_slot";
ALTER TABLE "media" DROP COLUMN "origin_id";

COMMIT;
