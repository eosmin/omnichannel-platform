-- The first answer of an automation, apart from the first answer of a person (TDD_11 §7.2). first_response_at stays the answer of a person only.
ALTER TABLE "conversations" ADD COLUMN "first_automated_response_at" TIMESTAMP(3);

-- What identifies an analytics event, so that a job delivered twice writes one row. NULL for an event whose producer has no such id (several NULLs are allowed by the index).
ALTER TABLE "analytics_events" ADD COLUMN "event_key" TEXT;
CREATE UNIQUE INDEX "analytics_events_store_id_event_key_key" ON "analytics_events"("store_id", "event_key");
