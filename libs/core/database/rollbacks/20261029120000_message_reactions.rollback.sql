-- Rolls back 20261029120000_message_reactions: every reaction (customer, agent and external) is lost.
-- The messages they were left on keep everything else.
BEGIN;

DROP TABLE IF EXISTS "message_reactions";

COMMIT;
