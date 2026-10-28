-- AlterTable
ALTER TABLE "message_reactions" ADD COLUMN "delivery_status" TEXT NOT NULL DEFAULT 'sent',
ADD COLUMN "delivery_error" TEXT;
