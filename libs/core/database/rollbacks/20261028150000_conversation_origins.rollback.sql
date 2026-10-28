-- Rolls back 20261028150000_conversation_origins: the origin of each conversation (the ad or the post
-- it came from) is lost, with the raw referral of the provider. The messages keep everything else.
BEGIN;

DROP TABLE "conversation_origins";

COMMIT;
