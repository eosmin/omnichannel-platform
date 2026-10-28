-- CreateTable
CREATE TABLE "message_reactions" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "author_type" TEXT NOT NULL,
    "customer_identity_id" TEXT,
    "user_id" TEXT,
    "emoji" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "message_reactions_message_id_customer_identity_id_key" ON "message_reactions"("message_id", "customer_identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_reactions_message_id_user_id_key" ON "message_reactions"("message_id", "user_id");

-- CreateIndex
CREATE INDEX "message_reactions_store_id_idx" ON "message_reactions"("store_id");

-- CreateIndex
CREATE INDEX "message_reactions_customer_identity_id_idx" ON "message_reactions"("customer_identity_id");

-- CreateIndex
CREATE INDEX "message_reactions_user_id_idx" ON "message_reactions"("user_id");

-- AddForeignKey
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_customer_identity_id_fkey" FOREIGN KEY ("customer_identity_id") REFERENCES "customer_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Each author type has its own id column and no other: a customer by identity, an agent by user, and
-- the owner of the provider's own app by neither
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_author_check" CHECK (
    (author_type = 'customer' AND customer_identity_id IS NOT NULL AND user_id IS NULL)
    OR (author_type = 'agent' AND user_id IS NOT NULL AND customer_identity_id IS NULL)
    OR (author_type = 'external' AND customer_identity_id IS NULL AND user_id IS NULL)
);

-- The external reactor is one per message, and a NULL is never equal to another in the unique indexes above
CREATE UNIQUE INDEX "message_reactions_external_key" ON "message_reactions"("message_id") WHERE author_type = 'external';
