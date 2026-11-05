-- Rolls back 20261110120000_channel_connection_label: the names the owner gave to connections are lost, and
-- every connection shows the name of its account again.
BEGIN;

ALTER TABLE "channel_connections" DROP COLUMN IF EXISTS "label";

COMMIT;
