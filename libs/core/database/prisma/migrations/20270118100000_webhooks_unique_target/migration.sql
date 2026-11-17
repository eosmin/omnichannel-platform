-- A store cannot hold two webhooks that send the same events to the same address (OPS-SET-460): two
-- POST /settings/webhooks at once made two, and each event was then delivered twice to the receiver.
-- A webhook the platform disabled is not counted, so a broken copy can be kept next to its replacement.

-- No writer between the rewrite, the dedupe and the index (a webhook made meanwhile by an api that still runs the old code
-- would fail the build of the index); reads go on
LOCK TABLE "webhooks" IN SHARE ROW EXCLUSIVE MODE;

-- The set of events is stored in a canonical order (the api sorts it from now on, by code unit: COLLATE "C"), so that
-- the same set is always the same array and the index below can compare them
UPDATE "webhooks" w
SET "events" = ARRAY(SELECT e FROM unnest(w."events") AS e ORDER BY e COLLATE "C")
WHERE w."events" IS DISTINCT FROM ARRAY(SELECT e FROM unnest(w."events") AS e ORDER BY e COLLATE "C");

-- A pair that already exists keeps one webhook: the active one, and the oldest of those. The other copies are disabled,
-- not deleted: they keep their secret and their log, and the store can delete them or change them on purpose
UPDATE "webhooks" w
SET "status" = 'disabled'
WHERE w."status" <> 'disabled'
  AND EXISTS (
    SELECT 1 FROM "webhooks" keeper
    WHERE keeper."store_id" = w."store_id" AND keeper."url" = w."url" AND keeper."events" = w."events"
      AND keeper."status" <> 'disabled'
      AND keeper."id" <> w."id"
      AND (
        (keeper."status" = 'active' AND w."status" <> 'active')
        OR (keeper."status" = w."status" AND (keeper."created_at", keeper."id") < (w."created_at", w."id"))));

-- The address by its hash: a long one (it may be 2048 characters) would not fit in an entry of the index
CREATE UNIQUE INDEX IF NOT EXISTS "uq_webhooks_store_url_events" ON "webhooks" ("store_id", md5("url"), "events")
  WHERE "status" <> 'disabled';
