-- A reaction (and a quote) can be on ONE FILE of an album: each file of a message the platform sent, or a customer
-- sent, is its own message at the provider. `media_id` null is the message itself. A person has one reaction for
-- each target, so the two unique indexes of (message, person) take the file in: raw SQL on coalesce(media_id, ''),
-- because Postgres treats NULLs as distinct and Prisma cannot say otherwise (the pattern of uq_roles_store_name).
ALTER TABLE "message_reactions" ADD COLUMN "media_id" TEXT;
ALTER TABLE "message_reactions"
  ADD CONSTRAINT "message_reactions_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "message_reactions_media_id_idx" ON "message_reactions"("media_id");
CREATE INDEX "message_reactions_message_id_idx" ON "message_reactions"("message_id");

DROP INDEX "message_reactions_message_id_customer_identity_id_key";
DROP INDEX "message_reactions_message_id_user_id_key";
CREATE UNIQUE INDEX uq_message_reactions_customer
  ON "message_reactions" ("message_id", "customer_identity_id", (COALESCE("media_id", '')))
  WHERE "customer_identity_id" IS NOT NULL;
CREATE UNIQUE INDEX uq_message_reactions_user
  ON "message_reactions" ("message_id", "user_id", (COALESCE("media_id", '')))
  WHERE "user_id" IS NOT NULL;

ALTER TABLE "messages" ADD COLUMN "reply_to_media_id" TEXT;
