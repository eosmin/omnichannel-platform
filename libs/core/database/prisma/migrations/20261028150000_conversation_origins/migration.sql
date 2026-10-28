-- CreateTable
CREATE TABLE "conversation_origins" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source_id" TEXT,
    "source_url" TEXT,
    "title" TEXT,
    "body" TEXT,
    "media_type" TEXT,
    "media_ref" TEXT,
    "media_url" TEXT,
    "thumbnail_url" TEXT,
    "click_id" TEXT,
    "referral" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_origins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversation_origins_message_id_key" ON "conversation_origins"("message_id");

-- CreateIndex
CREATE INDEX "conversation_origins_conversation_id_created_at_idx" ON "conversation_origins"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "conversation_origins_store_id_idx" ON "conversation_origins"("store_id");

-- AddForeignKey
ALTER TABLE "conversation_origins" ADD CONSTRAINT "conversation_origins_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_origins" ADD CONSTRAINT "conversation_origins_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_origins" ADD CONSTRAINT "conversation_origins_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

