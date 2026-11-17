-- A store cannot hold two webhooks that send the same events to the same address (OPS-SET-460): two
-- POST /settings/webhooks at once made two, and each event was then delivered twice to the receiver.
-- A webhook the platform disabled is not counted, so a broken copy can be kept next to its replacement.

-- The set of events is stored in a canonical order (the api sorts it from now on), so that the same set is
-- always the same array and the index below can compare them
UPDATE "webhooks" w
SET "events" = ARRAY(SELECT e FROM unnest(w."events") AS e ORDER BY e)
WHERE w."events" IS DISTINCT FROM ARRAY(SELECT e FROM unnest(w."events") AS e ORDER BY e);

-- A pair that already exists keeps its oldest webhook; the later copies are disabled, not deleted: they keep
-- their secret and their log, and the store can delete them or change them on purpose
UPDATE "webhooks" w
SET "status" = 'disabled'
WHERE w."status" <> 'disabled'
  AND EXISTS (
    SELECT 1 FROM "webhooks" older
    WHERE older."store_id" = w."store_id" AND older."url" = w."url" AND older."events" = w."events"
      AND older."status" <> 'disabled'
      AND (older."created_at", older."id") < (w."created_at", w."id"));

CREATE UNIQUE INDEX "uq_webhooks_store_url_events" ON "webhooks" ("store_id", "url", "events")
  WHERE "status" <> 'disabled';
