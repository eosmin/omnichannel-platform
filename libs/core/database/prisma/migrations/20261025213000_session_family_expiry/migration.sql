-- A login ends at a fixed time, however often its refresh token is used (the cap of
-- MVP_TRIM_CHECKLIST.md section 10, item 1). Every row of a family carries the same value.
ALTER TABLE "sessions" ADD COLUMN "family_expires_at" TIMESTAMP(3);

-- Rows that exist were refreshed with no cap: their login started with the oldest row of the family,
-- and gets the default 30 days from there (SESSION_MAX_AGE)
UPDATE "sessions" s
SET "family_expires_at" = (
  SELECT min(f."created_at") FROM "sessions" f WHERE f."family_id" = s."family_id"
) + interval '30 days';

ALTER TABLE "sessions" ALTER COLUMN "family_expires_at" SET NOT NULL;
