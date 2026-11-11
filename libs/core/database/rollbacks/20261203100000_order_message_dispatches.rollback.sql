BEGIN;

-- Safe to run twice. The table only records what was sent or why it was not (the messages themselves live in `messages` and
-- in the email queue), so dropping it loses the "not sent, reason" lines of the timeline and the memory that stops a repeated
-- carrier event from sending twice: run it only together with the code that wrote it
DROP TABLE IF EXISTS "order_message_dispatches";
DROP INDEX IF EXISTS "orders_store_id_id_key";

COMMIT;
