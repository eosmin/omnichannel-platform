-- The owner may name each connection ("Instagram principal"). The name of the account that the provider
-- gave stays in `display_name` and is what is shown while the label is null; a label is never written by a
-- connect, a reconnect or a token update.
-- AlterTable
ALTER TABLE "channel_connections" ADD COLUMN "label" TEXT;
