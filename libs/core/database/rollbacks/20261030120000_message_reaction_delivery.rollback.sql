-- Rolls back 20261030120000_message_reaction_delivery: the delivery state of the reactions of agents is
-- lost; the reactions themselves stay.
BEGIN;

ALTER TABLE "message_reactions" DROP COLUMN IF EXISTS "delivery_error", DROP COLUMN IF EXISTS "delivery_status";

COMMIT;
