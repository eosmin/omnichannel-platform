BEGIN;

-- Safe to run twice. The event key only guards against a redelivered job and first_automated_response_at only feeds the report of
-- automated answers: dropping them loses those two facts and nothing else (first_response_at is not touched).
DROP INDEX IF EXISTS "analytics_events_store_id_event_key_key";
ALTER TABLE "analytics_events" DROP COLUMN IF EXISTS "event_key";
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "first_automated_response_at";

COMMIT;
