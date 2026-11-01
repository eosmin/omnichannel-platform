-- The picture and the thumbnail of an ad become files of the store (purpose origin): a media row can
-- belong to the origin of a conversation, and goes with it.
-- AlterTable
ALTER TABLE "media" ADD COLUMN "origin_id" TEXT,
ADD COLUMN "origin_slot" TEXT;

-- CreateIndex
CREATE INDEX "media_origin_id_idx" ON "media"("origin_id");

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_origin_id_fkey" FOREIGN KEY ("origin_id") REFERENCES "conversation_origins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
